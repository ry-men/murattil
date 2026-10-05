"""Exporte muaalem-mini (sysofwan/hifzguide-muaalem-mini, 116 M paramètres) en ONNX pour le navigateur.

Lancé par GitHub Actions (.github/workflows/export-mini.yml) : ce dépôt n'a pas besoin de Hugging Face
au moment de la construction du site, le modèle est publié comme « release » GitHub.

Sorties (dossier passé en argument) :
  muaalem_mini.int8.onnx   modèle quantifié int8 (navigateur, WebAssembly)
  muaalem_mini.onnx        modèle float32 (référence)
  muaalem_mini_vocab.json  identifiant -> phonème
  report.json              tailles, écarts torch/onnx, temps, transcription de test
"""
import json
import os
import sys
import time
import urllib.request

import numpy as np
import torch

REPO = os.environ.get("MINI_MODEL", "sysofwan/hifzguide-muaalem-mini")
OUT = sys.argv[1] if len(sys.argv) > 1 else "out"
os.makedirs(OUT, exist_ok=True)
report = {"model": REPO}


def log(*a):
    print(*a, flush=True)


# 1. Chargement (CTC standard Wav2Vec2-BERT, sinon la classe multi-niveaux de quran-muaalem)
from transformers import AutoConfig, AutoFeatureExtractor

cfg = AutoConfig.from_pretrained(REPO)
log("config :", cfg.architectures, getattr(cfg, "position_embeddings_type", None), getattr(cfg, "vocab_size", None))
report["architectures"] = cfg.architectures
model = None
errors = []
for loader in ("auto_ctc", "w2v2bert_ctc", "muaalem_multilevel"):
    try:
        if loader == "auto_ctc":
            from transformers import AutoModelForCTC
            model = AutoModelForCTC.from_pretrained(REPO)
        elif loader == "w2v2bert_ctc":
            from transformers import Wav2Vec2BertForCTC
            model = Wav2Vec2BertForCTC.from_pretrained(REPO)
        else:
            from quran_muaalem.modeling.modeling_multi_level_ctc import Wav2Vec2BertForMultilevelCTC
            model = Wav2Vec2BertForMultilevelCTC.from_pretrained(REPO)
        report["loader"] = loader
        break
    except Exception as e:  # noqa: BLE001
        errors.append(f"{loader}: {e}")
if model is None:
    raise SystemExit("Impossible de charger le modèle :\n" + "\n".join(errors))
model.eval()
log("chargé avec", report["loader"], "-", sum(p.numel() for p in model.parameters()) / 1e6, "M paramètres")
fe = AutoFeatureExtractor.from_pretrained(REPO)


class Wrapper(torch.nn.Module):
    """Renvoie seulement les logits des phonèmes."""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, input_features, attention_mask):
        out = self.m(input_features=input_features, attention_mask=attention_mask, return_dict=False)[0]
        if isinstance(out, dict):
            out = out["phonemes"]
        return out


wrapped = Wrapper(model).eval()

# 2. Vocabulaire : celui du modèle s'il existe, sinon celui de quran-muaalem (PAD + 42 phonèmes)
vocab = None
try:
    from huggingface_hub import hf_hub_download
    p = hf_hub_download(REPO, "vocab.json")
    v = json.load(open(p))
    if isinstance(v, dict) and "phonemes" in v:
        v = v["phonemes"]
    vocab = {int(i): t for t, i in v.items()}
except Exception as e:  # noqa: BLE001
    log("vocab.json absent du modèle :", e)
if vocab is None:
    from dataclasses import asdict
    from quran_transcript import alphabet as alph
    vocab = {0: "[PAD]"}
    for i, ph in enumerate(asdict(alph.phonetics).values(), start=1):
        vocab[i] = ph
json.dump({str(k): v for k, v in sorted(vocab.items())}, open(f"{OUT}/muaalem_mini_vocab.json", "w"), ensure_ascii=False)
report["vocab_size"] = len(vocab)


def decode(logits):
    ids = logits.argmax(-1)
    out, prev = [], 0
    for i in ids:
        i = int(i)
        if i != 0 and i != prev:
            out.append(vocab.get(i, ""))
        prev = i
    return "".join(out)


# 3. Audio de test : Al-Mulk 1-4 (corpus de test public de Tilawa)
url = "https://raw.githubusercontent.com/yazinsai/tilawa/main/lab/benchmark/test_corpus/multi_067_001_004.wav"
wav_path = f"{OUT}/test.wav"
urllib.request.urlretrieve(url, wav_path)
import soundfile as sf
wave, sr = sf.read(wav_path, dtype="float32")
if wave.ndim > 1:
    wave = wave.mean(1)
if sr != 16000:
    import librosa
    wave = librosa.resample(wave, orig_sr=sr, target_sr=16000)
wave = wave[: 16000 * 12]
feats = fe(wave, sampling_rate=16000, return_tensors="pt")
x, mask = feats["input_features"], feats["attention_mask"]
with torch.inference_mode():
    t0 = time.time()
    ref_logits = wrapped(x, mask)
    report["torch_seconds_12s_audio"] = round(time.time() - t0, 3)
report["test_transcript_torch"] = decode(ref_logits[0])
log("transcription torch :", report["test_transcript_torch"])

# 4. Export ONNX
onnx_path = f"{OUT}/muaalem_mini.onnx"
torch.onnx.export(
    wrapped, (x, mask), onnx_path,
    input_names=["input_features", "attention_mask"], output_names=["logits"],
    dynamic_axes={"input_features": {0: "b", 1: "t"}, "attention_mask": {0: "b", 1: "t"}, "logits": {0: "b", 1: "t"}},
    opset_version=17, do_constant_folding=True, dynamo=False,
)
import onnxruntime as ort


def run(path):
    s = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    t0 = time.time()
    y = s.run(None, {"input_features": x.numpy(), "attention_mask": mask.numpy().astype(np.int64)})[0]
    return y, time.time() - t0


y32, t32 = run(onnx_path)
report["onnx_fp32_max_abs_diff"] = float(np.abs(y32 - ref_logits.numpy()).max())
report["onnx_fp32_transcript_equal"] = decode(torch.from_numpy(y32[0])) == report["test_transcript_torch"]

# 5. Quantification int8 dynamique (poids des MatMul)
from onnxruntime.quantization import quantize_dynamic, QuantType
q_path = f"{OUT}/muaalem_mini.int8.onnx"
quantize_dynamic(onnx_path, q_path, weight_type=QuantType.QInt8)
y8, t8 = run(q_path)
tr8 = decode(torch.from_numpy(y8[0]))
import Levenshtein
report["int8_transcript"] = tr8
report["int8_char_agreement"] = round(Levenshtein.ratio(tr8, report["test_transcript_torch"]), 4)
report["onnx_seconds"] = {"fp32": round(t32, 3), "int8": round(t8, 3)}
report["sizes_mb"] = {os.path.basename(p): round(os.path.getsize(p) / 1e6, 1) for p in (onnx_path, q_path)}
# Données de test pour vérifier l'implémentation navigateur (features + transcription attendue)
np.asarray(wave, dtype="<f4").tofile(f"{OUT}/test_pcm.f32")
json.dump(report, open(f"{OUT}/report.json", "w"), ensure_ascii=False, indent=1)
log(json.dumps(report, ensure_ascii=False, indent=1))

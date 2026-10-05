"""Exporte muaalem-mini (sysofwan/hifzguide-muaalem-mini, 116 M paramètres) en ONNX pour le navigateur.

Sécurité : AUCUN code téléchargé n'est exécuté (pas de trust_remote_code).
- On télécharge seulement des fichiers de données : config.json, model.safetensors (format sûr, sans code),
  preprocessor_config.json, phoneme_vocab.json.
- Le dépôt est épinglé à une révision précise (MINI_REVISION) : si l'auteur le modifie, rien ne change ici.
- L'architecture est reconstruite avec les classes standard de transformers (Wav2Vec2BertModel)
  + une couche linéaire (tête « phonemes »), comme dans modeling_multi_level_ctc.py du modèle.

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
REVISION = os.environ.get("MINI_REVISION", "a2bebf7c2e9a74d9ff5c3269594132d7caea7696")
LOCAL = os.environ.get("MINI_LOCAL_DIR")  # tests : dossier contenant déjà les fichiers
OUT = sys.argv[1] if len(sys.argv) > 1 else "out"
os.makedirs(OUT, exist_ok=True)
report = {"model": REPO, "revision": REVISION}


def log(*a):
    print(*a, flush=True)


def fetch(name: str) -> str:
    if LOCAL:
        return os.path.join(LOCAL, name)
    from huggingface_hub import hf_hub_download
    return hf_hub_download(REPO, name, revision=REVISION)


# 1. Configuration : les clés propres au multi-niveaux sont retirées, le reste va dans Wav2Vec2BertConfig.
from transformers import SeamlessM4TFeatureExtractor, Wav2Vec2BertConfig, Wav2Vec2BertModel

raw = json.load(open(fetch("config.json")))
heads = raw.get("level_to_vocab_size") or {"phonemes": 43}
custom = {"auto_map", "architectures", "model_type", "level_to_vocab_size", "level_to_loss_weight", "transformers_version", "dtype", "torch_dtype"}
cfg = Wav2Vec2BertConfig(**{k: v for k, v in raw.items() if k not in custom})
report["config"] = {k: raw.get(k) for k in ("hidden_size", "num_hidden_layers", "num_attention_heads", "add_adapter", "position_embeddings_type")}
log("config :", report["config"], "têtes :", heads)


class MiniCTC(torch.nn.Module):
    """Même structure (et mêmes noms de poids) que Wav2Vec2BertForMultilevelCTC du modèle."""

    def __init__(self, config, heads):
        super().__init__()
        self.wav2vec2_bert = Wav2Vec2BertModel(config)
        out = config.output_hidden_size if getattr(config, "add_adapter", False) else config.hidden_size
        self.level_to_lm_head = torch.nn.ModuleDict({k: torch.nn.Linear(out, v) for k, v in heads.items()})

    def forward(self, input_features, attention_mask):
        h = self.wav2vec2_bert(input_features, attention_mask=attention_mask, return_dict=False)[0]
        return self.level_to_lm_head["phonemes"](h)


model = MiniCTC(cfg, heads)
from safetensors.torch import load_file

state = load_file(fetch("model.safetensors"))
res = model.load_state_dict(state, strict=False)
# Le chargement doit être exact : sinon le modèle exporté serait faux.
missing = [k for k in res.missing_keys if "masked_spec_embed" not in k]
report["missing_keys"], report["unexpected_keys"] = missing, list(res.unexpected_keys)
if missing or res.unexpected_keys:
    raise SystemExit(f"Poids incompatibles.\nManquants : {missing[:20]}\nEn trop : {list(res.unexpected_keys)[:20]}")
model.eval()
report["params_millions"] = round(sum(p.numel() for p in model.parameters()) / 1e6, 1)
log("chargé :", report["params_millions"], "M paramètres")

pp = json.load(open(fetch("preprocessor_config.json")))
fe = SeamlessM4TFeatureExtractor(**{k: v for k, v in pp.items() if k != "feature_extractor_type"})

# 2. Vocabulaire : id2label de la config (identique à phoneme_vocab.json)
vocab = {int(i): t for i, t in raw["id2label"].items()}
try:
    pv = json.load(open(fetch("phoneme_vocab.json")))
    if "id_to_char" in pv:
        report["vocab_matches_phoneme_vocab"] = [vocab[i] for i in range(len(vocab))] == pv["id_to_char"]
except Exception as e:  # noqa: BLE001
    log("phoneme_vocab.json illisible :", e)
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
wav_path = os.environ.get("MINI_TEST_WAV") or f"{OUT}/test.wav"
if not os.environ.get("MINI_TEST_WAV"):
    url = "https://raw.githubusercontent.com/yazinsai/tilawa/main/lab/benchmark/test_corpus/multi_067_001_004.wav"
    urllib.request.urlretrieve(url, wav_path)
import soundfile as sf

wave, sr = sf.read(wav_path, dtype="float32")
if wave.ndim > 1:
    wave = wave.mean(1)
if sr != 16000:
    n = int(len(wave) * 16000 / sr)
    wave = np.interp(np.linspace(0, len(wave) - 1, n), np.arange(len(wave)), wave).astype(np.float32)
wave = wave[: 16000 * 12]
feats = fe(wave, sampling_rate=16000, return_tensors="pt")
x, mask = feats["input_features"], feats["attention_mask"].to(torch.int64)
with torch.no_grad():  # pas inference_mode : le cache rotary serait inutilisable pour l'export
    t0 = time.time()
    ref_logits = model(x, mask)
    report["torch_seconds_12s_audio"] = round(time.time() - t0, 3)
report["test_transcript_torch"] = decode(ref_logits[0])
log("transcription torch :", report["test_transcript_torch"])

# 4. Export ONNX
# Le module rotary garde en cache cos/sin pour la dernière longueur vue : pendant le traçage, ce cache
# deviendrait une constante (le modèle ne marcherait qu'à cette longueur). On le désactive.
from transformers.models.wav2vec2_bert import modeling_wav2vec2_bert as w2vb

_rot_forward = w2vb.Wav2Vec2BertRotaryPositionalEmbedding.forward


def _rot_no_cache(self, hidden_states):
    self.cached_sequence_length = None
    self.cached_rotary_positional_embedding = None
    return _rot_forward(self, hidden_states)


w2vb.Wav2Vec2BertRotaryPositionalEmbedding.forward = _rot_no_cache
onnx_path = f"{OUT}/muaalem_mini.onnx"
with torch.no_grad():
  torch.onnx.export(
    model, (x, mask), onnx_path,
    input_names=["input_features", "attention_mask"], output_names=["logits"],
    dynamic_axes={"input_features": {0: "b", 1: "t"}, "attention_mask": {0: "b", 1: "t"}, "logits": {0: "b", 1: "t"}},
    opset_version=17, do_constant_folding=True, dynamo=False,
)
import onnxruntime as ort


def run(path, xx=x, mm=mask):
    s = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    t0 = time.time()
    y = s.run(None, {"input_features": xx.numpy(), "attention_mask": mm.numpy().astype(np.int64)})[0]
    return y, time.time() - t0


y32, t32 = run(onnx_path)
report["onnx_fp32_max_abs_diff"] = float(np.abs(y32 - ref_logits.numpy()).max())
report["onnx_fp32_transcript_equal"] = decode(torch.from_numpy(y32[0])) == report["test_transcript_torch"]
# Axe temporel vraiment dynamique : audio plus court (3 s) et plus long (30 s) que celui du traçage.
report["onnx_other_lengths"] = {}
for secs in (3, 30):
    w = np.tile(wave, int(np.ceil(secs * 16000 / len(wave))))[: secs * 16000]
    f = fe(w, sampling_rate=16000, return_tensors="pt")
    m = f["attention_mask"].to(torch.int64)
    ys, _ = run(onnx_path, f["input_features"], m)
    with torch.no_grad():
        ts = model(f["input_features"], m).numpy()
    d = float(np.abs(ys - ts).max())
    report["onnx_other_lengths"][f"{secs}s"] = {"frames": ys.shape[1], "max_abs_diff": d, "argmax_equal": float((ys.argmax(-1) == ts.argmax(-1)).mean())}
    if d > 1e-2:
        raise SystemExit(f"ONNX faux sur {secs} s d'audio (écart {d})")

# 5. Quantification int8 dynamique (poids des MatMul)
from onnxruntime.quantization import QuantType, quantize_dynamic

q_path = f"{OUT}/muaalem_mini.int8.onnx"
quantize_dynamic(onnx_path, q_path, weight_type=QuantType.QInt8)
y8, t8 = run(q_path)
tr8 = decode(torch.from_numpy(y8[0]))
import Levenshtein

report["int8_transcript"] = tr8
report["int8_char_agreement"] = round(Levenshtein.ratio(tr8, report["test_transcript_torch"]), 4)

# 6. Variante de secours : poids stockés en float16 (taille / 2), convertis en float32 au chargement.
#    Calcul identique au float32, donc aucune perte de précision ; fichier ~2x plus gros que l'int8.
import onnx
from onnx import helper, numpy_helper

g = onnx.load(onnx_path)
new_inits, casts = [], []
for init in list(g.graph.initializer):
    arr = numpy_helper.to_array(init)
    if arr.dtype == np.float32 and arr.size >= 4096:
        new_inits.append(numpy_helper.from_array(arr.astype(np.float16), init.name + "_f16"))
        casts.append(helper.make_node("Cast", [init.name + "_f16"], [init.name], to=onnx.TensorProto.FLOAT, name=init.name + "_cast"))
        g.graph.initializer.remove(init)
g.graph.initializer.extend(new_inits)
for n in reversed(casts):
    g.graph.node.insert(0, n)
f16_path = f"{OUT}/muaalem_mini.f16w.onnx"
onnx.save(g, f16_path)
y16, t16 = run(f16_path)
tr16 = decode(torch.from_numpy(y16[0]))
report["f16w_char_agreement"] = round(Levenshtein.ratio(tr16, report["test_transcript_torch"]), 4)

# 7. Choix automatique pour le téléphone : int8 (petit) s'il reste fidèle, sinon poids float16.
web = q_path if report["int8_char_agreement"] >= 0.93 else f16_path
report["web_variant"] = os.path.basename(web)
import shutil

shutil.copyfile(web, f"{OUT}/muaalem_mini.web.onnx")
report["onnx_seconds"] = {"fp32": round(t32, 3), "int8": round(t8, 3), "f16w": round(t16, 3)}
report["sizes_mb"] = {os.path.basename(p): round(os.path.getsize(p) / 1e6, 1) for p in (onnx_path, q_path, f16_path)}
# Données de test pour vérifier l'implémentation navigateur (features + transcription attendue)
np.asarray(wave, dtype="<f4").tofile(f"{OUT}/test_pcm.f32")
json.dump(report, open(f"{OUT}/report.json", "w"), ensure_ascii=False, indent=1)
log(json.dumps(report, ensure_ascii=False, indent=1))

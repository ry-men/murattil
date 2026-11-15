"""Filtre de confiance (rapport de vraisemblance CTC) appliqué à muaalem-mini (ONNX int8, celui du téléphone).

    MINI_DIR=<dossier export_mini.py> REF_DIR=<pros> python tests/mini_llr_eval.py pros   -> tests/out/mini_pros.json
    MINI_DIR=... AUDIO_DIR=<audios de Ryan>         python tests/mini_llr_eval.py ryan   -> tests/out/mini_ryan.json
Chaque faute brute (familles de bruit gardées) reçoit delta = log P(faute) - log P(correct).
"""
import json, os, sys, subprocess
from pathlib import Path
import numpy as np, soundfile as sf, onnxruntime as ort, torch
from transformers import SeamlessM4TFeatureExtractor
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server")); sys.path.insert(0, str(ROOT / "tests"))
import analysis
from analysis import analyze_segment, ayah_text, _phonetize, default_moshaf, confidence_filter

for k in analysis.FILTERS:
    analysis.FILTERS[k] = k == "reprise"
D = os.environ.get("MINI_DIR", "/tmp/mini")
VOCAB = {int(k): v for k, v in json.load(open(os.path.join(D, "muaalem_mini_vocab.json"))).items()}
IDS = {v: k for k, v in VOCAB.items() if k != 0}
SESS = ort.InferenceSession(os.path.join(D, "muaalem_mini.web.onnx"), providers=["CPUExecutionProvider"])
FE = SeamlessM4TFeatureExtractor(feature_size=80, num_mel_bins=80, padding_value=1, stride=2, sampling_rate=16000)
MO = default_moshaf()


def logprobs(w):
    f = FE(w, sampling_rate=16000, return_tensors="np")
    lg = SESS.run(None, {"input_features": f["input_features"], "attention_mask": f["attention_mask"].astype(np.int64)})[0][0]
    return torch.log_softmax(torch.from_numpy(lg).float(), -1)


def greedy(lp):
    out, fr, prev = [], [], 0
    for t, i in enumerate(lp.argmax(-1).tolist()):
        if i and i != prev:
            out.append(VOCAB[i]); fr.append(t)
        prev = i
    return "".join(out), fr


def loglik(lp, text):
    ids = [IDS[c] for c in text if c in IDS]
    if not ids or len(ids) > lp.shape[0]:
        return -1e9
    return -float(torch.nn.functional.ctc_loss(lp.unsqueeze(1), torch.tensor([ids]), torch.tensor([lp.shape[0]]), torch.tensor([len(ids)]),
                                               blank=0, reduction="sum", zero_infinity=True))


def one(lp, pred, s, a):
    res = analyze_segment(pred, s, a, a, MO)
    confidence_filter(res, pred, lambda t: loglik(lp, t), min_delta=-1e9)
    return {"pred": pred, "aligned": bool(res),
            "errors": [{"word": e.word, "cat": e.category, "msg": e.message, "noise": e.noise, "delta": e.confidence} for r in res for e in r.errors]}


def pros():
    d = os.environ["REF_DIR"]; out = []
    for k, m in enumerate(json.load(open(os.path.join(d, "meta.json")))):
        w, _ = sf.read(os.path.join(d, m["file"]), dtype="float32")
        lp = logprobs(w); pred, _ = greedy(lp)
        out.append({**m, **one(lp, pred, m["surah"], m["ayah"])})
        if k % 50 == 0:
            print(k, flush=True)
    json.dump(out, open(ROOT / "tests/out/mini_pros.json", "w"), ensure_ascii=False)


def ryan():
    from server_eval import best_slice
    P = {"07.05.54.aac": (61, 1, 14), "07.05.54_1.aac": (67, 12, 13), "07.06.01.aac": (74, 21, 22), "07.06.01_1.aac": (78, 1, 40), "07.06.02.aac": (70, 24, 25)}
    out = []
    for f in sorted(Path(os.environ["AUDIO_DIR"]).glob("*.aac")):
        s, a, b = P[f.name.split("_at_")[1]]
        w = np.frombuffer(subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(f), "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1"]), dtype=np.float32).copy()
        # Logits par morceaux de 14 s (comme l'app), puis découpage par ayah sur les phonèmes du mini.
        from model_split import split_long
        lp = torch.cat([logprobs(p) for p in split_long(w)])
        pred, fr = greedy(lp)
        for ay in range(a, b + 1):
            r, i, j = best_slice(_phonetize(ayah_text(s, ay), MO, s).phonemes, pred)
            if r < 0.5:
                continue
            t0, t1 = max(0, fr[i] - 15), min(lp.shape[0], fr[min(j, len(fr)) - 1] + 15)
            sub = lp[t0:t1]
            p2, _ = greedy(sub)
            out.append({"reciter": "ryan", "surah": s, "ayah": ay, **one(sub, p2, s, ay)})
    json.dump(out, open(ROOT / "tests/out/mini_ryan.json", "w"), ensure_ascii=False)


{"pros": pros, "ryan": ryan}[sys.argv[1]]()

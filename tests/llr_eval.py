"""Expérience : filtre par rapport de vraisemblance CTC (le modèle préfère-t-il vraiment la faute ?).

Pour chaque faute signalée : A = référence exacte, B = référence avec seulement cette faute.
delta = log P(B | audio) - log P(A | audio). Petit delta = le modèle hésite -> faute pas fiable.
    REF_DIR=... python tests/llr_eval.py pros   # audios des pros (tarteel-ai/everyayah, split test) + meta.json
    AUDIO_DIR=... python tests/llr_eval.py ryan # audios de Ryan
Résultat (oct. 2026) : delta médian 1,3 chez les pros, 12 chez Ryan ; seuil retenu 4 (analysis.MIN_DELTA).
"""
import json, os, sys
from pathlib import Path
import numpy as np, torch, soundfile as sf
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server")); sys.path.insert(0, str(ROOT / "tests"))
from model import Muaalem, split_long
import analysis
from analysis import analyze_segment, ayah_text, _phonetize, default_moshaf
for _f in os.environ.get("FILTERS_OFF", "").split(","):
    if _f:
        analysis.FILTERS[_f] = False

REF = os.environ.get("REF_DIR", "tests/audio/ref")      # audios des pros + meta.json
AUDIO = os.environ.get("AUDIO_DIR", "tests/audio/ryan")  # audios de Ryan (non versionnés)
M = Muaalem(); MO = default_moshaf()
V = {c: i for i, c in M.vocab.items()}


@torch.inference_mode()
def logprobs(w):
    out = []
    for part in split_long(w):
        f = M.processor(part, sampling_rate=16000, return_tensors="pt")
        lg = M.model(**f, return_dict=False)[0]["phonemes"][0]
        out.append(torch.log_softmax(lg.float(), -1))
    return torch.cat(out)


def greedy(lp):
    ids = lp.argmax(-1).tolist(); s, fr, prev = [], [], 0
    for t, i in enumerate(ids):
        if i != 0 and i != prev:
            s.append(M.vocab[i]); fr.append(t)
        prev = i
    return "".join(s), fr


def ll(lp, text):
    tgt = torch.tensor([V[c] for c in text if c in V])
    if len(tgt) == 0 or len(tgt) > lp.shape[0]:
        return -1e9
    return -torch.nn.functional.ctc_loss(lp.unsqueeze(1), tgt.unsqueeze(0), torch.tensor([lp.shape[0]]), torch.tensor([len(tgt)]),
                                         blank=0, reduction="sum", zero_infinity=True).item()


def score(lp, s, a, pred):
    ref = _phonetize(ayah_text(s, a), MO, s).phonemes
    res = analyze_segment(pred, s, a, a)
    out = []
    if not res:
        return out
    base = ll(lp, ref)
    for e in res[0].errors:
        st, en = e.ph
        b = ref[:st] + (e.heard or "") + ref[en:]
        out.append({"word": e.word, "cat": e.category, "msg": e.message, "exp": e.expected, "heard": e.heard,
                    "span_ok": ref[st:en] == (e.expected or ""), "noise": e.noise, "delta": round(ll(lp, b) - base, 2)})
    return out


def pros():
    meta = json.load(open(os.path.join(REF, "meta.json"))); rows = []
    for k, m in enumerate(meta):
        w, _ = sf.read(os.path.join(REF, m["file"]), dtype="float32")
        lp = logprobs(w); pred, _ = greedy(lp)
        rows.append({**m, "errors": score(lp, m["surah"], m["ayah"], pred)})
        print(k, m["file"], len(rows[-1]["errors"]), flush=True)
    json.dump(rows, open(ROOT / f"tests/out/llr_pros{os.environ.get('TAG', '')}.json", "w"), ensure_ascii=False)


def ryan():
    from server_eval import load_audio, best_slice
    P = {"07.05.54.aac": (61, 1, 14), "07.05.54_1.aac": (67, 12, 13), "07.06.01.aac": (74, 21, 22), "07.06.01_1.aac": (78, 1, 40), "07.06.02.aac": (70, 24, 25)}
    rows = []
    for f in sorted(Path(AUDIO).glob("*.aac")):
        s, a, b = P[f.name.split("_at_")[1]]
        lp = logprobs(load_audio(f)); pred, fr = greedy(lp)
        for ay in range(a, b + 1):
            ref = _phonetize(ayah_text(s, ay), MO, s).phonemes
            r, i, j = best_slice(ref, pred)
            if r < 0.6:
                continue
            t0, t1 = max(0, fr[i] - 4), min(lp.shape[0], fr[min(j, len(fr)) - 1] + 5)
            rows.append({"surah": s, "ayah": ay, "errors": score(lp[t0:t1], s, ay, pred[i:j])})
            print(s, ay, len(rows[-1]["errors"]), flush=True)
    json.dump(rows, open(ROOT / f"tests/out/llr_ryan{os.environ.get('TAG', '')}.json", "w"), ensure_ascii=False)


{"pros": pros, "ryan": ryan}[sys.argv[1]]()

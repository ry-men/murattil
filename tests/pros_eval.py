"""Mesure complète du gros modèle (une passe par ayah) : phonèmes, fautes brutes, confiance, sifat.

    REF_DIR=<dossier avec meta.json + wav> python tests/pros_eval.py pros   -> tests/out/eval_pros.json
    AUDIO_DIR=<audios de Ryan>            python tests/pros_eval.py ryan   -> tests/out/eval_ryan.json
Ensuite : python tests/pros_report.py (seuils, taux de fausses fautes, par récitateur).

Toutes les familles de bruit sont gardées (analysis.FILTERS à False sauf « reprise ») et chaque faute reçoit
son delta de confiance : le rapport peut ainsi rejouer n'importe quel réglage sans relancer le modèle.
"""
import json, os, sys, time
from pathlib import Path
import soundfile as sf
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server")); sys.path.insert(0, str(ROOT / "tests"))
import analysis
from analysis import analyze_segment, ayah_text, _phonetize, default_moshaf, SIFA_ATTRS, confidence_filter
from model import Muaalem
import Levenshtein

for k in analysis.FILTERS:
    analysis.FILTERS[k] = k == "reprise"
M = Muaalem(); MO = default_moshaf()


def one(w, s, a):
    ref = _phonetize(ayah_text(s, a), MO, s)
    pred, sif, lp = M.analyze(w, ref)
    res = analyze_segment(pred, s, a, a, MO)
    confidence_filter(res, pred, lambda t: M.loglik(lp, t), min_delta=-1e9)
    errs = [{"word": e.word, "cat": e.category, "msg": e.message, "noise": e.noise, "delta": e.confidence,
             "exp": e.expected, "heard": e.heard} for r in res for e in r.errors]
    rg = [x.phonemes for x in ref.sifat]; pg = [getattr(x, "phonemes_group", "") or "" for x in sif]
    raw = []
    for tag, i1, i2, j1, j2 in Levenshtein.opcodes([g[:1] for g in rg], [g[:1] for g in pg]):
        if tag != "equal":
            continue
        for k in range(i2 - i1):
            r, p = ref.sifat[i1 + k], sif[j1 + k]
            for at in SIFA_ATTRS:
                u = getattr(p, at, None)
                if u is not None and u.text != getattr(r, at):
                    raw.append((at, getattr(r, at), u.text, round(float(u.prob), 3), r.phonemes))
    return {"pred": pred, "aligned": bool(res), "errors": errs, "sifat": raw}


def pros():
    d = os.environ.get("REF_DIR", "tests/audio/ref"); out = []
    meta = json.load(open(os.path.join(d, "meta.json")))
    t0 = time.time()
    for k, m in enumerate(meta):
        w, _ = sf.read(os.path.join(d, m["file"]), dtype="float32")
        if w.ndim > 1:
            w = w.mean(1)
        out.append({**m, **one(w, m["surah"], m["ayah"])})
        if k % 25 == 0:
            print(k, len(meta), round(time.time() - t0), flush=True)
            json.dump(out, open(ROOT / "tests/out/eval_pros.json", "w"), ensure_ascii=False)
    json.dump(out, open(ROOT / "tests/out/eval_pros.json", "w"), ensure_ascii=False)


def ryan():
    from server_eval import load_audio, best_slice
    P = {"07.05.54.aac": (61, 1, 14), "07.05.54_1.aac": (67, 12, 13), "07.06.01.aac": (74, 21, 22), "07.06.01_1.aac": (78, 1, 40), "07.06.02.aac": (70, 24, 25)}
    out = []
    for f in sorted(Path(os.environ.get("AUDIO_DIR", "tests/audio/ryan")).glob("*.aac")):
        s, a, b = P[f.name.split("_at_")[1]]
        w = load_audio(f); lp = M.logprobs(w)
        ids = lp.argmax(-1).tolist(); pred, fr, prev = [], [], 0
        for t, i in enumerate(ids):
            if i != 0 and i != prev:
                pred.append(M.vocab[i]); fr.append(t)
            prev = i
        pred = "".join(pred); fps = lp.shape[0] / (len(w) / 16000)
        for ay in range(a, b + 1):
            r, i, j = best_slice(_phonetize(ayah_text(s, ay), MO, s).phonemes, pred)
            if r < 0.6:
                continue
            t0 = max(0, int((fr[i] / fps - 0.35) * 16000)); t1 = min(len(w), int((fr[min(j, len(fr)) - 1] / fps + 0.35) * 16000))
            if t1 - t0 > 40 * 16000:
                continue
            out.append({"reciter": "ryan", "surah": s, "ayah": ay, **one(w[t0:t1], s, ay)})
            print(s, ay, len(out[-1]["errors"]), flush=True)
    json.dump(out, open(ROOT / "tests/out/eval_ryan.json", "w"), ensure_ascii=False)


{"pros": pros, "ryan": ryan}[sys.argv[1]]()

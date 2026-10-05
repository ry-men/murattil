"""Calibre les filtres de server/analysis.py : fausses fautes chez des pros vs fautes signalées chez Ryan.

    python tests/calibrate.py
Entrées : tests/data/ref_pros_server.json (phonèmes du serveur Muaalem sur 126 ayahs, 7 récitateurs,
           tarteel-ai/everyayah split test)
          tests/out/ryan_ayahs.json (facultatif, non versionné : phonèmes de Ryan découpés par ayah)
Aucun appel GPU : on rejoue seulement l'analyse.
Attention : ce script mesure les filtres « durs » seuls. Depuis v0.6.4, la plupart des familles sont jugées
par le filtre de confiance (analysis.confidence_filter) : voir tests/llr_eval.py et tests/data/llr_pros.json.
"""
import json, sys, itertools
from collections import Counter
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
import analysis
from analysis import analyze_segment, ayah_text

ref = json.loads((ROOT / "tests/data/ref_pros_server.json").read_text())
RY = ROOT / "tests/out/ryan_ayahs.json"
ry = json.loads(RY.read_text()) if RY.exists() else {}


def run(items):
    n_err, words, ayahs_err, n_words = 0, 0, 0, 0
    cats = Counter()
    for s, a, pred in items:
        res = analyze_segment(pred, s, a, a)
        errs = [e for r in res for e in r.errors]
        n_err += len(errs); ws = {e.word for e in errs}; words += len(ws); ayahs_err += bool(errs)
        n_words += len(ayah_text(s, a).split())
        cats.update(e.category for e in errs)
    n = len(items)
    return f"{n_err / n:4.2f} faute/ayah · {100 * words / n_words:4.1f} % mots · {100 * ayahs_err / n:3.0f} % ayahs · {dict(cats)}"


PROS = [(r["surah"], r["ayah"], r["predicted"]) for r in ref]
RYAN = [(int(k.split(":")[0]), int(k.split(":")[1]), v["pred_margin"]) for k, v in ry.items() if v["ratio"] >= 0.6]
keys = list(analysis.FILTERS)
for on in [()] + [(k,) for k in keys] + [tuple(keys)]:
    for k in keys:
        analysis.FILTERS[k] = k in on
    print(f"filtres {'+'.join(on) or 'aucun':40} PROS {run(PROS)}")
    if RYAN:
        print(f"{'':49}RYAN {run(RYAN)}")

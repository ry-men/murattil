"""Rapport de calibrage à partir de tests/out/eval_{pros,ryan}.json (ou mini_{pros,ryan}.json avec --mini).
Sans tests/out : utilise tests/data/eval_pros.json (663 ayahs, 34 récitateurs, versionné).

    python tests/pros_report.py [--mini]
- Fausses fautes par ayah chez les pros (toute faute y est fausse), par famille et par récitateur.
- Points gardés chez Ryan pour les mêmes réglages.
- Recherche du seuil par famille : le plus bas qui garde la famille sous ~0,01 fausse faute / ayah.
"""
import json, sys
from collections import Counter, defaultdict
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
from analysis import EXTRA_DELTA, MIN_DELTA, SIFA_RULES

pre = "mini" if "--mini" in sys.argv else "eval"
_src = ROOT / f"tests/out/{pre}_pros.json"
P = json.load(open(_src if _src.exists() else ROOT / f"tests/data/{pre}_pros.json"))  # tests/data : version allégée versionnée
RY = ROOT / f"tests/out/{pre}_ryan.json"
R = json.load(open(RY)) if RY.exists() else []
FAMS = ["", "bord", "ghunna1", "chadda", "voyelle", "confusion", "madd_long"]


def fam(e):
    if e["noise"]:
        return e["noise"]
    return "madd_long" if e["msg"].startswith("Madd naturel (2 temps) : trop long") else ""


def kept(e, base, extra, hard=("ghunna1",)):
    if fam(e) in hard:
        return False
    d = e["delta"]
    return d is None or d >= base + extra.get(fam(e), 0.0)


def rate(rows, base, extra, hard=("ghunna1",)):
    n = len(rows)
    errs = [e for r in rows for e in r["errors"] if kept(e, base, extra, hard)]
    return len(errs) / max(1, n), errs


print(f"{len(P)} ayahs pros ({len({r['reciter'] for r in P})} récitateurs), {len(R)} ayahs Ryan · modèle : {pre}")
print(f"non alignées : pros {sum(not r['aligned'] for r in P)}, Ryan {sum(not r['aligned'] for r in R)}")
print("\nRéglage actuel (MIN_DELTA, EXTRA_DELTA) et variantes :")
for name, base in [("souple", 12), ("normal", MIN_DELTA), ("strict", 5)]:  # = SEVERITY_DELTA dans src/tajwid.ts
    rp, ep = rate(P, base, EXTRA_DELTA); rr, er = rate(R, base, EXTRA_DELTA)
    print(f"  {name:7} delta>={base:<4} pros {rp:.3f}/ayah (1 toutes les {1 / max(rp, 1e-9):.0f}) · Ryan {rr:.2f}/ayah · pros par cat {dict(Counter(e['cat'] for e in ep))}")

print("\nPar famille (seuil = MIN_DELTA + supplément) : fausses fautes pros / points Ryan par ayah")
for f in FAMS:
    line = f"  {f or 'autres':9}"
    for extra in (0, 2, 4, 8, 12):
        p = sum(1 for r in P for e in r["errors"] if fam(e) == f and (e["delta"] is None or e["delta"] >= MIN_DELTA + extra)) / len(P)
        q = sum(1 for r in R for e in r["errors"] if fam(e) == f and (e["delta"] is None or e["delta"] >= MIN_DELTA + extra)) / max(1, len(R))
        line += f" | +{extra:<2} {p:.3f} {q:.2f}"
    print(line)

print("\nPar récitateur (réglage normal) : fausses fautes / ayah")
by = defaultdict(list)
for r in P:
    by[r["reciter"]].append(r)
worst = sorted(((rate(v, MIN_DELTA, EXTRA_DELTA)[0], k, len(v)) for k, v in by.items()), reverse=True)
for x, k, n in worst[:8]:
    print(f"  {k:32} {x:.2f} ({n} ayahs)")
print("  ...", f"{sum(1 for x, _, _ in worst if x == 0)} récitateurs sans aucune fausse faute")

print("\nFausses fautes restantes chez les pros (normal), par message :")
_, ep = rate(P, MIN_DELTA, EXTRA_DELTA)
for m, c in Counter(e["msg"] for e in ep).most_common(12):
    print(f"  {c:3} {m}")

if "sifat" in P[0]:
    print("\nSifat (Atelier) : fausses fautes pros / points Ryan par ayah, règles SIFA_RULES")
    def sif(rows):
        return sum(1 for r in rows for (a, e, g, p, ph) in r["sifat"] if a in SIFA_RULES and (e, g) in SIFA_RULES[a][1] and p >= SIFA_RULES[a][0]) / max(1, len(rows))
    def sif_all(rows):
        return sum(r.get("sifat_n", len(r["sifat"])) for r in rows) / max(1, len(rows))
    print(f"  toutes : pros {sif_all(P):.2f} · Ryan {sif_all(R):.2f}   |   règles gardées : pros {sif(P):.3f} · Ryan {sif(R):.2f}")

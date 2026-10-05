"""Test du recalage de scripts/gen_tajweed.py sur des données synthétiques :
texte « source » = notre texte sans U+06ED ni signes de pause ; annotation hamzat_wasl sur chaque ٱ et qalqala sur chaque ق.
On vérifie qu'après recalage chaque couleur tombe sur la bonne lettre du mot affiché."""
import json, re, sys
sys.path.insert(0, "scripts")
import gen_tajweed as g

ROOT = sys.argv[1]
quran = json.load(open(f"{ROOT}/public/quran.json"))
src_lines, ann = [], []
for v in quran:
    t = v["text_uthmani"].replace("﻿", "")
    s = re.sub(r" +", " ", "".join(c for c in t if c not in "ۭۖۗۘۙۚۛ")).strip()
    src_lines.append(f"{v['surah']}|{v['ayah']}|{s}")
    a = [{"rule": "hamzat_wasl", "start": m.start(), "end": m.start() + 1} for m in re.finditer("ٱ", s)]
    a += [{"rule": "qalqalah", "start": m.start(), "end": m.start() + 2} for m in re.finditer("ق", s)]
    ann.append({"surah": v["surah"], "ayah": v["ayah"], "annotations": a})
g.get = lambda url: json.dumps(ann) if url == g.ANN else "\n".join(src_lines)
g.ROOT = ROOT
g.main()
out = json.load(open(f"{ROOT}/public/tajweed.json"))
import subprocess
# mots affichés : même découpage que l'app (via le script lui-même)
bad = ok = 0
for v in quran:
    key = f"{v['surah']}:{v['ayah']}"
    t = v["text_uthmani"].replace("﻿", "")
    rngs = g.word_ranges(t)
    first = 4 if v["ayah"] == 1 and v["surah"] not in (1, 9) and g.strip(t).startswith("بسم الله الرحمن الرحيم") else 0
    words = [t[a:b] for a, b in rngs][first:]
    for w, s, e, r in out["ayahs"].get(key, []):
        ch = words[w][s]
        exp = "ٱ" if out["rules"][r] == "hamzat_wasl" else "ق"
        ok += ch == exp
        bad += ch != exp
print("vérif lettres :", ok, "ok,", bad, "faux")
assert bad == 0

"""Coloration tajwid du texte affiché : annotations cpfair/quran-tajweed (CC-BY 4.0), recalées sur notre texte.

Aucune donnée inventée : les règles et leurs positions viennent telles quelles du projet cpfair/quran-tajweed
(calculées sur le texte Uthmani de Tanzil, copie d'avril 2017). Notre texte (public/quran.json) est ce même
texte avec des caractères ajoutés (signes de pause, espaces…). On aligne les deux textes ayah par ayah :
- si l'alignement ne contient QUE des insertions, les positions sont recalées exactement ;
- sinon l'ayah n'est pas colorée (jamais d'approximation).

Sortie : public/tajweed.json = {"rules": [...], "ayahs": {"s:a": [[mot, début, fin, règle], ...]}}
(positions relatives au mot affiché par l'app, voir src/quran.ts splitWords / ayahWords).
"""
import difflib
import json
import re
import sys
import urllib.request

ANN = "https://raw.githubusercontent.com/cpfair/quran-tajweed/master/output/tajweed.hafs.uthmani-pause-sajdah.json"
TXT = "https://github.com/cpfair/quran-tajweed/files/7281388/quran-uthmani.txt"
ROOT = sys.argv[1] if len(sys.argv) > 1 else "."

WAQF = set("ۖۗۘۙۚۛۜ")
BISMILLAH_WORDS = 4


def get(url):
    import subprocess
    return subprocess.check_output(["curl", "-fsSL", url]).decode("utf-8")


def strip(s):
    s = re.sub(r"[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭ]", "", s)
    return s.replace("ٱ", "ا")


def word_ranges(text):
    """Même découpage que splitWords (src/quran.ts) : liste de (début, fin) dans le texte."""
    toks = [(m.start(), m.end(), m.group()) for m in re.finditer(r"\S+", text)]
    out, pre = [], None
    for a, b, t in toks:
        if t == "۞":
            pre = a
            continue
        is_waqf = len(t) <= 2 and all(c in WAQF for c in t)
        if (is_waqf or t == "۩") and out:
            out[-1] = (out[-1][0], b)
        else:
            out.append((pre if pre is not None else a, b))
            pre = None
    return out


def main():
    quran = json.load(open(f"{ROOT}/public/quran.json"))
    overrides = json.load(open(f"{ROOT}/src/word-overrides.json"))
    ann = json.loads(get(ANN))
    tanzil = {}
    for line in get(TXT).splitlines():
        p = line.split("|")
        if len(p) == 3 and p[0].isdigit():
            tanzil[f"{p[0]}:{p[1]}"] = p[2].replace("﻿", "")
    rules = sorted({a["rule"] for x in ann for a in x["annotations"]})
    rid = {r: i for i, r in enumerate(rules)}
    by_key = {f"{x['surah']}:{x['ayah']}": x["annotations"] for x in ann}
    out, skipped, n_ann = {}, [], 0
    for v in quran:
        key = f"{v['surah']}:{v['ayah']}"
        ours = v["text_uthmani"].replace("﻿", "")
        src = tanzil.get(key)
        if src is None or key in overrides or key not in by_key:
            skipped.append((key, "absent/override"))
            continue
        sm = difflib.SequenceMatcher(None, src, ours, autojunk=False)
        ops = sm.get_opcodes()
        if any(op not in ("equal", "insert") for op, *_ in ops):
            skipped.append((key, "texte différent"))
            continue
        m = [None] * (len(src) + 1)
        for op, i1, i2, j1, j2 in ops:
            if op == "equal":
                for k in range(i2 - i1):
                    m[i1 + k] = j1 + k
        m[len(src)] = len(ours)
        ranges = word_ranges(ours)
        first = 0
        if v["ayah"] == 1 and v["surah"] not in (1, 9) and strip(ours).startswith("بسم الله الرحمن الرحيم"):
            first = BISMILLAH_WORDS
        items = []
        for a in by_key[key]:
            s, e = a["start"], a["end"]
            if s >= e or m[s] is None or m[e - 1] is None:
                continue
            os_, oe = m[s], m[e - 1] + 1
            # Vérification : chaque caractère annoté se retrouve à l'identique dans notre texte.
            if any(m[k] is None or ours[m[k]] != src[k] for k in range(s, e)):
                continue
            for wi, (wa, wb) in enumerate(ranges):
                lo, hi = max(os_, wa), min(oe, wb)
                # Le mot affiché par l'app doit être exactement ce morceau de texte (espaces simples).
                if lo < hi and wi >= first and " ".join(ours[wa:wb].split()) == ours[wa:wb]:
                    items.append([wi - first, lo - wa, hi - wa, rid[a["rule"]]])
            n_ann += 1
        if items:
            out[key] = items
    json.dump({"source": "cpfair/quran-tajweed (CC-BY 4.0), recalé sur le texte de l'app", "rules": rules, "ayahs": out},
              open(f"{ROOT}/public/tajweed.json", "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"règles : {rules}")
    print(f"ayahs colorées : {len(out)} / {len(quran)} ; annotations placées : {n_ann} ; ignorées : {len(skipped)}")
    for k, why in skipped[:15]:
        print("  ignorée", k, why)


if __name__ == "__main__":
    main()

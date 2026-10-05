"""Référence phonétique (rasm de quran-transcript) des 6236 ayahs, pour l'analyse tajwid sur le téléphone.

Pour chaque ayah (lue avec arrêt à la fin) : phonèmes, mot de chaque groupe de phonèmes, règles de tajwid.
Usage : python scripts/gen_tajwid_ref.py > public/tajwid_ref.json
"""
import json
from quran_transcript import Aya, quran_phonetizer
from quran_transcript.phonetics.moshaf_attributes import MoshafAttributes
from quran_transcript.phonetics.sifa import chunck_phonemes
from quran_transcript.phonetics.error_explainer import extract_ref_phonetic_to_uthmani, get_ref_phonetic_groups_tajweed_rules

BASMALA = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ"
moshaf = MoshafAttributes(rewaya="hafs", madd_monfasel_len=4, madd_mottasel_len=4, madd_mottasel_waqf=4, madd_aared_len=4)
KIND = {"Qalqalah": "qalqala", "IdghamKamel": "idgham", "Ghonnah": "ghonna", "LeenMaddRule": "leen"}
rules, rule_idx = [], {}


def rule_id(r):
    cls = type(r).__name__
    kind = KIND.get(cls, "madd" if "Madd" in cls or cls.endswith("NoonRule") else cls)
    d = {"k": kind, "c": cls, "en": r.name.en, "ar": r.name.ar, "g": r.golden_len, "t": r.correctness_type, "o": getattr(r, "offset", 0)}
    key = json.dumps(d, ensure_ascii=False, sort_keys=True)
    if key not in rule_idx:
        rule_idx[key] = len(rules)
        rules.append(d)
    return rule_idx[key]


def entry(text, surah):
    out = quran_phonetizer(text, moshaf, remove_spaces=True, sura_idx=surah)
    groups = chunck_phonemes(out.phonemes)
    ph2u = extract_ref_phonetic_to_uthmani(out.mappings)
    grules = get_ref_phonetic_groups_tajweed_rules(groups, out.mappings, ph2u)
    words, sparse, start = [], [], 0
    for gi, g in enumerate(groups):
        u = ph2u[start]
        words.append(text[:u].count(" "))
        for r in grules[gi]:
            sparse.append([gi, rule_id(r)])
        start += len(g)
    assert "".join(groups) == out.phonemes
    return [out.phonemes, words, sparse]


ayahs = {}
s = 1
while s <= 114:
    n = Aya(s, 1).get().num_ayat_in_sura
    for a in range(1, n + 1):
        ayahs[f"{s}:{a}"] = entry(Aya(s, a).get().uthmani, s)
    s += 1
print(json.dumps({"v": 1, "rules": rules, "basmala": ayahs["1:1"], "ayahs": ayahs}, ensure_ascii=False, separators=(",", ":")))

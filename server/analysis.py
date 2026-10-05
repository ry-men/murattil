"""Analyse d'une récitation avec Quran Muaalem : phonèmes prédits -> erreurs par mot, en français.

Ce module ne dépend pas du modèle (testable sans GPU) : il reçoit les phonèmes prédits.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from functools import lru_cache

import Levenshtein
from quran_transcript import Aya, quran_phonetizer, explain_error
from quran_transcript.phonetics.moshaf_attributes import MoshafAttributes

BASMALA = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ"

# Noms français des règles de tajwid (clé = nom anglais renvoyé par quran-transcript).
RULE_FR = {
    "Qalqalah": "Qalqala (rebond)",
    "Normal Madd": "Madd naturel (2 temps)",
    "Monfasel Madd": "Madd munfasil",
    "Mottasel Madd": "Madd muttasil",
    "Mottasel Madd Pause": "Madd muttasil (à l'arrêt)",
    "Lazem Madd": "Madd lazim (6 temps)",
    "Aared Madd": "Madd 'arid (à l'arrêt)",
    "Leen Madd": "Madd lin",
    "Full Merging": "Idgham complet",
    "Ghonnah": "Ghunna (nasalisation)",
}

# Durées admises en Hafs (en temps) : on ne signale pas une durée valide différente du réglage.
ALLOWED_LEN = {
    "Aared Madd": {2, 4, 6},
    "Leen Madd": {2, 4, 6},
    "Monfasel Madd": {2, 3, 4, 5},
    "Mottasel Madd": {4, 5, 6},
    "Mottasel Madd Pause": {4, 5, 6},
}

ARABIC_LETTERS = re.compile("[ء-ي]")
HARAKA_FR = {"َ": "fatha", "ُ": "damma", "ِ": "kasra", "ْ": "soukoun", "ّ": "chadda",
             "ً": "tanwin fath", "ٌ": "tanwin damm", "ٍ": "tanwin kasr"}


def _harakat(s: str) -> str:
    return ", ".join(HARAKA_FR[c] for c in s if c in HARAKA_FR)


@dataclass
class WordError:
    word: int
    word_text: str
    category: str  # harf | haraka | tajwid
    message: str
    expected: str
    heard: str
    rule_ar: str = ""
    rule_fr: str = ""


@dataclass
class AyahResult:
    surah: int
    ayah: int
    coverage: float
    reference: str
    predicted: str
    errors: list[WordError] = field(default_factory=list)


def default_moshaf() -> MoshafAttributes:
    return MoshafAttributes(
        rewaya="hafs",
        madd_monfasel_len=4,
        madd_mottasel_len=4,
        madd_mottasel_waqf=4,
        madd_aared_len=4,
    )


@lru_cache(maxsize=4096)
def ayah_text(surah: int, ayah: int) -> str:
    if ayah == 0:
        return BASMALA
    return Aya(surah, ayah).get().uthmani


def num_ayat(surah: int) -> int:
    return Aya(surah, 1).get().num_ayat_in_sura


def _phonetize(text: str, moshaf: MoshafAttributes, surah: int):
    return quran_phonetizer(text, moshaf, remove_spaces=True, sura_idx=surah)


def _letters(s: str) -> str:
    return "".join(ARABIC_LETTERS.findall(s))


def _describe(err, word_text: str) -> tuple[str, str, str, str]:
    """(catégorie, message, règle_ar, règle_fr)"""
    exp, got = err.expected_ph or "", err.preditected_ph or ""
    rules = err.ref_tajweed_rules or err.missing_tajweed_rules or err.replaced_tajweed_rules or err.inserted_tajweed_rules or []
    rule = rules[0] if rules else None
    rule_ar = getattr(getattr(rule, "name", None), "ar", "") if rule else ""
    rule_en = getattr(getattr(rule, "name", None), "en", "") if rule else ""
    rule_fr = RULE_FR.get(rule_en, rule_en)
    if err.error_type == "tajweed":
        if err.expected_len is not None and err.predicted_len is not None:
            longer = "trop long" if err.predicted_len > err.expected_len else "trop court"
            msg = f"{rule_fr or 'Tajwid'} : {longer} ({err.predicted_len} temps au lieu de {err.expected_len})"
        elif err.speech_error_type == "delete":
            msg = f"{rule_fr or 'Règle de tajwid'} non appliquée"
        else:
            msg = f"{rule_fr or 'Règle de tajwid'} mal appliquée"
        return "tajwid", msg, rule_ar, rule_fr
    if err.error_type == "tashkeel":
        if err.speech_error_type == "delete":
            return "haraka", "Haraka ou chadda manquante", rule_ar, rule_fr
        if err.speech_error_type == "insert":
            return "haraka", "Haraka en trop", rule_ar, rule_fr
        he, hg = _harakat(exp), _harakat(got)
        if he and hg and he != hg:
            return "haraka", f"Haraka : {hg} au lieu de {he}", rule_ar, rule_fr
        he, hg = _harakat(exp), _harakat(got)
        if he and hg and he != hg:
            return "haraka", f"Haraka : {hg} au lieu de {he}", rule_ar, rule_fr
        return "haraka", "Mauvaise haraka", rule_ar, rule_fr
    # erreur « normale » : lettre
    le, lg = _letters(exp), _letters(got)
    if err.speech_error_type == "delete":
        return "harf", f"Lettre oubliée : {le or exp}", rule_ar, rule_fr
    if err.speech_error_type == "insert":
        return "harf", f"Lettre en trop : {lg or got}", rule_ar, rule_fr
    if le and lg and le != lg:
        return "harf", f"Lettre : « {lg} » prononcé au lieu de « {le} »", rule_ar, rule_fr
    return "harf", "Prononciation différente", rule_ar, rule_fr


def _keep(err, word_idx: int, n_words: int, text: str = "") -> bool:
    """Filtre les « erreurs » qui sont des variantes admises."""
    # Début d'ayah avec hamzat al-wasl : la hamza disparaît si on lie avec l'ayah précédente (wasl).
    if word_idx == 0 and text.startswith("\u0671") and err.speech_error_type == "delete" and _letters(err.expected_ph or "") in ("ء", ""):
        return False
    rules = err.ref_tajweed_rules or err.replaced_tajweed_rules or []
    for r in rules:
        en = getattr(getattr(r, "name", None), "en", "")
        allowed = ALLOWED_LEN.get(en)
        if allowed and err.predicted_len in allowed:
            return False
    # Dernier mot de l'ayah : voyelle finale / tanwin selon arrêt ou liaison (waqf / wasl) -> admis.
    if word_idx == n_words - 1 and err.error_type in ("tashkeel", "tajweed"):
        return False
    return True


def _map_ref_to_pred(ref: str, pred: str) -> list[int]:
    """Alignement semi-global : le segment peut ne couvrir qu'une partie des ayahs de contexte.

    Renvoie, pour chaque position de ref (0..len), la position correspondante dans pred.
    Les débuts et fins de ref non récités sont gratuits (contexte ± 1 ayah).
    """
    n, m = len(ref), len(pred)
    INF = 10 ** 9
    D = [[0] * (m + 1) for _ in range(n + 1)]
    B = [[0] * (m + 1) for _ in range(n + 1)]  # 0 diag, 1 haut (ref supprimé), 2 gauche (pred inséré)
    for j in range(1, m + 1):
        D[0][j] = j
        B[0][j] = 2
    for i in range(1, n + 1):
        D[i][0] = 0  # début de ref libre
        B[i][0] = 1
        ri = ref[i - 1]
        Di, Dp, Bi = D[i], D[i - 1], B[i]
        for j in range(1, m + 1):
            d = Dp[j - 1] + (0 if ri == pred[j - 1] else 1)
            u = Dp[j] + 1
            l = Di[j - 1] + 1
            if d <= u and d <= l:
                Di[j] = d
            elif u <= l:
                Di[j] = u; Bi[j] = 1
            else:
                Di[j] = l; Bi[j] = 2
    # fin de ref libre : meilleure ligne pour la dernière colonne
    end_i = min(range(n + 1), key=lambda i: (D[i][m], -i))
    mp = [m] * (n + 1)
    for k in range(end_i, n + 1):
        mp[k] = m
    i, j = end_i, m
    while i > 0:
        if j == 0:
            mp[i - 1] = 0
            i -= 1
            continue
        b = B[i][j]
        if b == 0:
            mp[i - 1] = j - 1; i -= 1; j -= 1
        elif b == 1:
            mp[i - 1] = j; i -= 1
        else:
            j -= 1
    return mp


def _merge_word_omissions(errors: list[WordError], words: list[str]) -> list[WordError]:
    """Plusieurs lettres manquantes sur un même mot -> une seule erreur « Mot oublié »."""
    by: dict[int, list[WordError]] = {}
    for e in errors:
        by.setdefault(e.word, []).append(e)
    out: list[WordError] = []
    for w, errs in by.items():
        missing = "".join(_letters(e.expected) for e in errs if e.message.startswith("Lettre oubliée") or e.heard == "")
        letters = _letters(words[w])
        if letters and len(missing) >= 0.6 * len(letters) and all(e.heard == "" for e in errs):
            out.append(WordError(w, words[w], "mot", "Mot oublié", words[w], ""))
        else:
            out.extend(errs)
    return sorted(out, key=lambda e: e.word)


def _merge_word_omissions(errors: list[WordError], words: list[str]) -> list[WordError]:
    """Plusieurs lettres manquantes sur un même mot -> une seule erreur « Mot oublié »."""
    by: dict[int, list[WordError]] = {}
    for e in errors:
        by.setdefault(e.word, []).append(e)
    out: list[WordError] = []
    for w, errs in by.items():
        missing = "".join(_letters(e.expected) for e in errs if e.heard == "")
        letters = _letters(words[w])
        if letters and len(missing) >= 0.6 * len(letters) and all(e.heard == "" for e in errs):
            out.append(WordError(w, words[w], "mot", "Mot oublié", words[w], ""))
        else:
            out.extend(errs)
    return sorted(out, key=lambda e: e.word)


def analyze_segment(
    predicted: str,
    surah: int,
    ayah_from: int,
    ayah_to: int,
    moshaf: MoshafAttributes | None = None,
    include_basmala: bool = False,
    min_coverage: float = 0.6,
) -> list[AyahResult]:
    """Aligne les phonèmes prédits d'un segment sur les ayahs attendues (± 1 de contexte)."""
    moshaf = moshaf or default_moshaf()
    total = num_ayat(surah)
    ayahs = list(range(ayah_from, min(total, ayah_to) + 1))
    if include_basmala and ayah_from == 1 and surah not in (1, 9):
        ayahs = [0] + ayahs
    refs = [(a, ayah_text(surah, a), _phonetize(ayah_text(surah, a), moshaf, surah)) for a in ayahs]
    # Contexte court (fin de l'ayah précédente, début de la suivante) : absorbe les marges du segment
    # sans risquer d'aligner sur une ayah voisine qui se répète (ex. 78:4 et 78:5).
    CTX = 14
    prev_ctx = _phonetize(ayah_text(surah, ayah_from - 1), moshaf, surah).phonemes[-CTX:] if ayah_from > 1 else ""
    next_ctx = _phonetize(ayah_text(surah, ayah_to + 1), moshaf, surah).phonemes[:CTX] if ayah_to < total else ""
    full = prev_ctx + "".join(r[2].phonemes for r in refs) + next_ctx
    pos = _map_ref_to_pred(full, predicted)
    out: list[AyahResult] = []
    start = len(prev_ctx)
    for a, text, ph in refs:
        end = start + len(ph.phonemes)
        ps, pe = pos[start], pos[end]
        pred_slice = predicted[ps:pe]
        cov = Levenshtein.ratio(ph.phonemes, pred_slice) if ph.phonemes else 0.0
        if ayah_from <= a <= ayah_to and cov >= min_coverage:
            words = text.split()
            res = AyahResult(surah, a, round(cov, 3), ph.phonemes, pred_slice)
            for err in explain_error(uthmani_text=text, ref_ph_text=ph.phonemes, predicted_ph_text=pred_slice, mappings=ph.mappings):
                w = text[: err.uthmani_pos[0]].count(" ")
                w = min(w, len(words) - 1)
                if not _keep(err, w, len(words), text):
                    continue
                cat, msg, rar, rfr = _describe(err, words[w])
                res.errors.append(WordError(w, words[w], cat, msg, err.expected_ph or "", err.preditected_ph or "", rar, rfr))
            res.errors = _merge_word_omissions(res.errors, words)
            res.errors = _merge_word_omissions(res.errors, words)
            out.append(res)
        start = end
    return out


def to_json(results: list[AyahResult]) -> list[dict]:
    return [asdict(r) for r in results]


# ---------------------------------------------------------------------------
# Caractéristiques des lettres (sifat) : mode Atelier, une ayah à la fois
# ---------------------------------------------------------------------------
SIFA_ATTRS = ["tafkheem_or_taqeeq", "qalqla", "ghonna", "hams_or_jahr", "shidda_or_rakhawa", "itbaq", "safeer", "tikraar", "tafashie", "istitala"]
SIFA_FR = {
    "mofakham": "tafkhim (lettre épaisse)", "moraqaq": "tarqiq (lettre fine)", "low_mofakham": "tafkhim léger",
    "moqalqal": "qalqala (rebond)", "not_moqalqal": "sans qalqala",
    "maghnoon": "ghunna (nasalisation)", "not_maghnoon": "sans ghunna",
    "hams": "souffle (hams)", "jahr": "son voisé (jahr)",
    "shadeed": "son bloqué (shidda)", "rikhw": "son fluide (rakhawa)", "between": "son intermédiaire",
    "motbaq": "itbaq (langue plaquée)", "monfateh": "sans itbaq",
    "safeer": "sifflement (safir)", "no_safeer": "sans sifflement",
    "mokarar": "roulement (takrir)", "not_mokarar": "sans roulement",
    "motafashie": "diffusion (tafashshi)", "not_motafashie": "sans diffusion",
    "mostateel": "prolongement (istitala)", "not_mostateel": "sans prolongement",
}


def sifat_errors(pred_sifat, surah: int, ayah: int, moshaf: MoshafAttributes | None = None, min_prob: float = 0.7) -> list[WordError]:
    """Compare les sifat prédites (Muaalem) à celles de la référence, lettre par lettre."""
    moshaf = moshaf or default_moshaf()
    text = ayah_text(surah, ayah)
    ref = _phonetize(text, moshaf, surah)
    from quran_transcript.phonetics.error_explainer import extract_ref_phonetic_to_uthmani
    ph2u = extract_ref_phonetic_to_uthmani(ref.mappings)
    words = text.split()
    ref_groups = [x.phonemes for x in ref.sifat]
    starts, pos = [], 0
    for g in ref_groups:
        starts.append(pos)
        pos += len(g)
    pred_groups = [getattr(x, "phonemes_group", "") or "" for x in pred_sifat]
    out: list[WordError] = []
    for tag, i1, i2, j1, j2 in Levenshtein.opcodes([g[:1] for g in ref_groups], [g[:1] for g in pred_groups]):
        if tag != "equal":
            continue  # lettres différentes : déjà signalé par l'analyse des phonèmes
        for k in range(i2 - i1):
            r, p = ref.sifat[i1 + k], pred_sifat[j1 + k]
            w = min(text[: ph2u.get(starts[i1 + k], 0)].count(" "), len(words) - 1)
            for attr in SIFA_ATTRS:
                unit = getattr(p, attr, None)
                if unit is None:
                    continue
                got, prob = getattr(unit, "text", None), getattr(unit, "prob", 0.0)
                exp = getattr(r, attr)
                if got and got != exp and prob >= min_prob:
                    letter = _letters(r.phonemes)[:1] or r.phonemes[:1]
                    msg = f"{letter} : {SIFA_FR.get(exp, exp)} attendu, entendu {SIFA_FR.get(got, got)}"
                    out.append(WordError(w, words[w], "sifa", msg, exp, got, attr, SIFA_FR.get(exp, exp)))
    return out

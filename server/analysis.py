"""Analyse d'une récitation avec Quran Muaalem : phonèmes prédits -> erreurs par mot, en français.

Ce module ne dépend pas du modèle (testable sans GPU) : il reçoit les phonèmes prédits.
"""
from __future__ import annotations

import re
from collections import Counter
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
    ph: tuple = ()  # positions (début, fin) dans les phonèmes de référence de l'ayah
    exp_len: int | None = None  # madd : durée attendue / entendue
    got_len: int | None = None
    confidence: float | None = None  # log P(faute) - log P(correct) : plus c'est grand, plus c'est sûr
    noise: str = ""  # famille de bruit connue du modèle (si son filtre est désactivé)


@dataclass
class AyahResult:
    surah: int
    ayah: int
    coverage: float
    reference: str
    predicted: str
    errors: list[WordError] = field(default_factory=list)
    pred_span: tuple = ()  # (début, fin) de l'ayah dans les phonèmes prédits du segment


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
        elif err.speech_error_type == "delete" and not rule_fr and exp and set(exp) <= set("اۥۦ"):
            msg = "Voyelle longue oubliée : allonger 2 temps (madd naturel)"
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


# Filtres calibrés sur 126 ayahs de 7 récitateurs professionnels (EveryAyah, test) : octobre 2026.
# Chaque filtre retire une famille de fausses fautes du modèle (voir tests/calibrate.py).
# True = famille toujours retirée ; False = gardée, puis jugée par le filtre de confiance (confidence_filter),
# avec un seuil plus haut pour les familles bruitées (EXTRA_DELTA). Mesuré oct. 2026 sur 126 ayahs de pros :
# avec ces réglages, chadda / confusion / voyelle / bord n'ajoutent presque aucune fausse faute (tests/llr_eval.py).
FILTERS = {"bord": False, "ghunna1": True, "chadda": False, "voyelle": False, "confusion": False, "reprise": True}
EXTRA_DELTA = {"bord": 8.0, "voyelle": 4.0}
# Confusions de lettres du modèle (fréquentes chez les pros, rares comme vraie faute).
MODEL_CONFUSIONS = {("ط", "ق")}
_VOWELS = re.compile("[\u064B-\u0652]")


_UNITS = re.compile("[ء-يں۾]")
NASALS = "نمں۾"


def _units(s: str) -> str:
    """Lettres, y compris ن / م cachés (ikhfa, iqlab) : une lettre répétée = une unité de durée."""
    return "".join(_UNITS.findall(s))


def _ghunna(exp: str, got: str) -> str | None:
    """Message clair pour la ghunna, l'ikhfa et l'iqlab (au lieu de « chadda manquante »)."""
    eu, gu = _units(exp), _units(got)
    if not eu or len(set(eu)) != 1 or eu[0] not in NASALS or len(eu) < 3:
        return None
    c = eu[0]
    if c in "نم":  # نّ / مّ : ghunna de 2 temps
        if gu and set(gu) <= {c} and len(gu) <= len(eu) - 2:
            return f"Ghunna trop courte sur « {c}ّ » : tenir 2 temps"
        return None
    letter = "ن" if c == "ں" else "م"
    rule = "Ikhfa" if c == "ں" else "Ghunna (iqlab / ikhfa chafawi)"
    if not gu:
        return f"{rule} non appliqué : nasaliser le « {letter} »"
    if set(gu) <= set("نم"):
        return f"{rule} : « {letter} » prononcé net au lieu d'être caché avec ghunna"
    if set(gu) <= {c} and len(gu) <= len(eu) - 2:
        return f"{rule} trop court : tenir la ghunna 2 temps"
    return None


def _model_noise(err, n_ph: int | None) -> str | None:
    """Famille de fausse faute typique du modèle (voir FILTERS), ou None."""
    exp, got = err.expected_ph or "", err.preditected_ph or ""
    el, gl = _letters(exp), _letters(got)
    eu, gu = _units(exp), _units(got)
    ev, gv = "".join(_VOWELS.findall(exp)), "".join(_VOWELS.findall(got))
    start, end = err.ph_pos
    # Bord du segment : la toute 1re ou dernière lettre peut être coupée par le découpage audio.
    if err.speech_error_type == "delete" and (start == 0 or (n_ph is not None and end >= n_ph)):
        return "bord"
    # Même lettre, une unité de plus ou de moins.
    if eu and gu and len(set(eu + gu)) == 1 and abs(len(eu) - len(gu)) == 1 and (gv == ev or not gv):
        # ghunna (ن / م, 4 unités contre 3) : marge de mesure ; chadda d'une autre lettre (2 contre 1) : vraie faute possible.
        return "ghunna1" if eu[0] in NASALS and max(len(eu), len(gu)) >= 3 else "chadda"
    # Voyelle brève non entendue alors que la lettre est bien là.
    if el and el == gl and ev and not gv:
        return "voyelle"
    if (el[:1], gl[:1]) in MODEL_CONFUSIONS:
        return "confusion"
    return None


def _keep(err, word_idx: int, n_words: int, text: str = "", n_ph: int | None = None) -> bool:
    """Filtre les « erreurs » qui sont des variantes admises ou du bruit connu du modèle."""
    # Début d'ayah avec hamzat al-wasl : la hamza disparaît si on lie avec l'ayah précédente (wasl).
    if word_idx == 0 and text.startswith("\u0671") and err.speech_error_type == "delete" and _letters(err.expected_ph or "") in ("ء", ""):
        return False
    # Durée de madd : un écart d'un seul temps est dans la marge normale (et de mesure) -> pas signalé.
    if err.expected_len is not None and err.predicted_len is not None and abs(err.predicted_len - err.expected_len) < 2:
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
            spans = [e.ph for e in errs if e.ph]
            ph = (min(a for a, _ in spans), max(b for _, b in spans)) if spans else ()
            out.append(WordError(w, words[w], "mot", "Mot oublié", words[w], "", ph=ph))
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
            spans = [e.ph for e in errs if e.ph]
            ph = (min(a for a, _ in spans), max(b for _, b in spans)) if spans else ()
            out.append(WordError(w, words[w], "mot", "Mot oublié", words[w], "", ph=ph))
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
            res = AyahResult(surah, a, round(cov, 3), ph.phonemes, pred_slice, pred_span=(ps, pe))
            errs = explain_error(uthmani_text=text, ref_ph_text=ph.phonemes, predicted_ph_text=pred_slice, mappings=ph.mappings)
            # Reprise (l'élève répète un bout de l'ayah) : 3 insertions ou plus au même endroit.
            # Ce n'est pas une faute de tajwid ; le suivi en direct gère déjà les reprises.
            ins = Counter(tuple(e.ph_pos) for e in errs if e.speech_error_type == "insert")
            for err in errs:
                if FILTERS.get("reprise", True) and err.speech_error_type == "insert" and ins[tuple(err.ph_pos)] >= 3:
                    continue
                w = text[: err.uthmani_pos[0]].count(" ")
                w = min(w, len(words) - 1)
                fam = _model_noise(err, len(ph.phonemes))
                if fam and FILTERS.get(fam, True):
                    continue
                if not _keep(err, w, len(words), text, len(ph.phonemes)):
                    continue
                cat, msg, rar, rfr = _describe(err, words[w])
                gh = _ghunna(err.expected_ph or "", err.preditected_ph or "")
                if gh:
                    cat, msg = "tajwid", gh
                elif fam == "chadda":
                    eu, gu = _units(err.expected_ph or ""), _units(err.preditected_ph or "")
                    cat, msg = "haraka", (f"Chadda oubliée sur « {eu[0]} »" if len(gu) < len(eu) else f"Chadda en trop sur « {eu[0]} »")
                elif fam == "voyelle":
                    cat, msg = "haraka", "Voyelle brève (haraka) non prononcée"
                res.errors.append(WordError(w, words[w], cat, msg, err.expected_ph or "", err.preditected_ph or "", rar, rfr, tuple(err.ph_pos), err.expected_len, err.predicted_len, noise=fam or ""))
            res.errors = _merge_word_omissions(res.errors, words)
            res.errors = _merge_word_omissions(res.errors, words)
            out.append(res)
        start = end
    return out


# Rapport de vraisemblance (log) minimal pour garder une faute : calibré sur 126 ayahs de pros
# Seuil par défaut (réglage « normal » de l'app) : 0,08 fausse faute par ayah chez les pros (tests/llr_eval.py).
MIN_DELTA = 4.0


def confidence_filter(results: list[AyahResult], predicted: str, loglik, min_delta: float = MIN_DELTA) -> None:
    """Garde une faute seulement si le modèle préfère nettement la version fautive à la version correcte.

    loglik(texte) -> log P(texte | audio) (CTC sur tout le segment). Pour chaque faute :
      A = phonèmes entendus hors de l'ayah + référence exacte de l'ayah
      B = pareil, mais avec seulement cette faute
    delta = loglik(B) - loglik(A). Petit delta : le modèle hésite, la faute n'est pas fiable.
    """
    for r in results:
        if not r.errors or not r.pred_span:
            continue
        ps, pe = r.pred_span
        before, after, ref = predicted[:ps], predicted[pe:], r.reference
        base = loglik(before + ref + after)
        kept = []
        for e in r.errors:
            st, en = e.ph if len(e.ph) == 2 else (None, None)
            if st is None or ref[st:en] != (e.expected or ""):
                kept.append(e)  # faute regroupée (mot entier…) : position inconnue, on la garde
                continue
            delta = loglik(before + ref[:st] + (e.heard or "") + ref[en:] + after) - base
            e.confidence = round(delta, 1)
            if delta >= min_delta + EXTRA_DELTA.get(e.noise, 0.0):
                kept.append(e)
        r.errors = kept


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


# Sifat gardées (calibrage oct. 2026, 126 ayahs de pros) : les autres attributs (hams/jahr, shidda/rakhawa,
# safir, takrir, tafashi, istitala, ghunna) donnent ~0,8 fausse faute par ayah chez les pros, même à 99 % de
# probabilité : non fiables. On garde 2 fautes utiles pour un élève, à ~0,02 fausse faute par ayah :
#  - lettre épaisse prononcée fine (ر, ق…), probabilité >= 0,99 ;
#  - qalqala absente sur ق ط ب ج د, probabilité >= 0,9.
SIFA_RULES = {
    "tafkheem_or_taqeeq": (0.99, {("mofakham", "moraqaq")}),
    "qalqla": (0.9, {("moqalqal", "not_moqalqal")}),
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
            for attr, (thr, kinds) in SIFA_RULES.items():
                unit = getattr(p, attr, None)
                if unit is None:
                    continue
                got, prob = getattr(unit, "text", None), getattr(unit, "prob", 0.0)
                exp = getattr(r, attr)
                if got and got != exp and (exp, got) in kinds and prob >= max(thr, min_prob):
                    letter = _letters(r.phonemes)[:1] or r.phonemes[:1]
                    msg = f"{letter} : {SIFA_FR.get(exp, exp)} attendu, entendu {SIFA_FR.get(got, got)}"
                    out.append(WordError(w, words[w], "sifa", msg, exp, got, attr, SIFA_FR.get(exp, exp)))
    return out

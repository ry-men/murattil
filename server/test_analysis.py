"""Tests texte seulement (sans modèle) : on simule des phonèmes prédits."""
from analysis import analyze_segment, ayah_text, _phonetize, default_moshaf

m = default_moshaf()
ph = lambda a: _phonetize(ayah_text(78, a), m, 78).phonemes

# 1. Récitation conforme de 78:3-5 avec arrêt à chaque fin d'ayah -> aucune erreur.
pred = ph(3) + ph(4) + ph(5)
r = analyze_segment(pred, 78, 3, 5)
assert [x.ayah for x in r] == [3, 4, 5], r
assert all(not x.errors for x in r), [x.errors for x in r]
print("ok conforme")

# 2. Avec un bout de l'ayah précédente au début du segment (marge) -> toujours aucune erreur.
pred2 = ph(2)[-6:] + pred
r = analyze_segment(pred2, 78, 3, 5)
assert all(not x.errors for x in r if x.ayah in (3, 4, 5)), [(x.ayah, x.errors) for x in r]
print("ok marge")

# 3. Lettre changée (ك -> ق) dans 78:4 mot 0, haraka changée dans 78:5 mot 0.
bad = ph(3) + ph(4).replace("كَ", "قَ", 1) + ph(5).replace("ثُ", "ثِ", 1)
r = {x.ayah: x for x in analyze_segment(bad, 78, 3, 5)}
e4, e5 = r[4].errors, r[5].errors
print("78:4", [(e.word, e.category, e.message) for e in e4])
print("78:5", [(e.word, e.category, e.message) for e in e5])
assert e4 and e4[0].category == "harf" and e4[0].word == 0
assert e5 and e5[0].category == "haraka" and e5[0].word == 0

# 4. Madd 'arid à 2 temps au lieu de 4 : variante admise -> pas d'erreur. Madd naturel trop long -> erreur.
r = analyze_segment(ph(2).replace("ۦۦۦۦم", "ۦۦم"), 78, 2, 2)
assert not r[0].errors, r[0].errors
print("ok madd arid 2 temps admis")

# 5. Mot oublié (ayah 4 sans « كلا »).
r = {x.ayah: x for x in analyze_segment(ph(3) + ph(4).replace("كَللَاا", "", 1) + ph(5), 78, 3, 5)}
print("oubli", [(e.word, e.category, e.message) for e in r[4].errors])
assert r[4].errors and r[4].errors[0].word == 0

# 6. Segment d'une seule ayah dont le texte se répète dans l'ayah suivante (78:4 / 78:5).
r = analyze_segment(ph(4).replace("كَ", "قَ", 1), 78, 4, 4)
assert r and r[0].ayah == 4 and r[0].errors and r[0].errors[0].category == "harf", r
print("ok ayahs répétées")

# 7. Sifat : une lettre prononcée fine au lieu d'épaisse (ق de « حدائق » 78:32 n'existe pas ; on prend 78:1 « عم »).
from types import SimpleNamespace as NS
from analysis import sifat_errors, SIFA_ATTRS
ref = _phonetize(ayah_text(78, 13), m, 78)  # وَجَعَلْنَا سِرَاجًا وَهَّاجًا
pred = []
for x in ref.sifat:
    d = {"phonemes_group": x.phonemes}
    for a in SIFA_ATTRS:
        d[a] = NS(text=getattr(x, a), prob=0.95)
    pred.append(NS(**d))
assert not sifat_errors(pred, 78, 13), "aucune erreur attendue"
# On modifie le tafkhim du ر (rَ) : moraqaq -> mofakham, et la qalqala du ج.
for p_ in pred:
    if p_.phonemes_group.startswith("ر"):
        assert p_.tafkheem_or_taqeeq.text == "mofakham"
        p_.tafkheem_or_taqeeq = NS(text="moraqaq", prob=0.995)
        break
errs = sifat_errors(pred, 78, 13)
print("sifat", [(e.word, e.message) for e in errs])
assert errs and errs[0].category == "sifa" and errs[0].word == 1
print("ok sifat")

# 8. Filtres anti-bruit (calibrés sur des récitateurs pros) et messages ghunna / ikhfa.
import analysis
from analysis import confidence_filter
p = ph(21)  # 78:21 إِنَّ جَهَنَّمَ كَانَتْ مِرْصَادًا
r = analyze_segment(p.replace("ننننَ", "نننَ", 1), 78, 21, 21)
assert not r[0].errors, ("ghunna à 1 unité près : admise", r[0].errors)
r = analyze_segment(p.replace("ننننَ", "نَ", 1), 78, 21, 21)
assert r[0].errors and r[0].errors[0].category == "tajwid" and "Ghunna trop courte" in r[0].errors[0].message, r[0].errors
print("ok ghunna", r[0].errors[0].message)
p40 = ph(40)  # 78:40 ... أَنذَرْنَـٰكُمْ (ikhfa)
assert "ںںں" in p40
r = analyze_segment(p40.replace("ںںں", "ن", 1), 78, 40, 40)
assert any("Ikhfa" in e.message for e in r[0].errors), r[0].errors
print("ok ikhfa")
# Reprise : l'élève répète « عَبَسَ » -> pas de « lettres en trop » en rafale.
p74 = _phonetize(ayah_text(74, 22), m, 74).phonemes
rep = p74.replace("عَبَسَ", "عَبَسَعَبَسَ", 1)
r = analyze_segment(rep, 74, 22, 22)
assert not [e for e in r[0].errors if e.message.startswith("Lettre en trop")], r[0].errors
print("ok reprise")
# Voyelle brève avalée et 1re lettre coupée : gardées, marquées comme famille bruitée (seuil de confiance plus haut).
r = analyze_segment(p[1:].replace("كَاانَت", "كاانَت", 1), 78, 21, 21)
assert sorted(e.noise for e in r[0].errors) == ["bord", "voyelle"], [(e.message, e.noise) for e in r[0].errors]
res = analyze_segment(p[1:].replace("كَاانَت", "كاانَت", 1), 78, 21, 21)
pred_ = p[1:].replace("كَاانَت", "كاانَت", 1)
confidence_filter(res, pred_, lambda t: 0.0 if t == pred_ else -6.0)   # delta 6 : assez pour une faute normale,
assert not res[0].errors, res[0].errors                                 # pas pour « bord » (12) ni « voyelle » (8)
print("ok bord + voyelle")
# Chadda oubliée sur une lettre normale (رَبِّ -> رَبِ) : signalée.
p78_37 = _phonetize(ayah_text(78, 37), m, 78).phonemes
assert "ببِ" in p78_37
r = analyze_segment(p78_37.replace("ببِ", "بِ", 1), 78, 37, 37)
assert r[0].errors and r[0].errors[0].noise == "chadda" and r[0].errors[0].message == "Chadda oubliée sur « ب »", r[0].errors
print("ok chadda")
# 9. Filtre de confiance : une faute est gardée seulement si le modèle la préfère nettement (delta >= MIN_DELTA).
from analysis import confidence_filter
p78 = ph(4)
bad = p78.replace("كَ", "قَ", 1)
res = analyze_segment(bad, 78, 4, 4)
assert res[0].errors
sure = lambda t: 0.0 if t == bad else -50.0      # le modèle préfère nettement la version fautive
confidence_filter(res, bad, sure)
assert res[0].errors and res[0].errors[0].confidence == 50.0, res[0].errors
res = analyze_segment(bad, 78, 4, 4)
unsure = lambda t: -1.0 if t == bad else -2.0    # le modèle hésite (delta = 1)
confidence_filter(res, bad, unsure)
assert not res[0].errors, res[0].errors
print("ok confiance")
print("TOUS LES TESTS OK")

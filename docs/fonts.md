# Polices et affichages du Coran : sources vérifiées

Règle : aucune donnée inventée. Seulement des textes et données publiés, avec licence claire, recalés exactement.

## Couleurs du tajwid (fait en v0.6)
- Données : cpfair/quran-tajweed, `output/tajweed.hafs.uthmani-pause-sajdah.json` (CC-BY 4.0), positions sur le texte Tanzil Uthmani (copie 2017, licence Tanzil).
- Texte source : `https://github.com/cpfair/quran-tajweed/files/7281388/quran-uthmani.txt`. Inaccessible depuis la sandbox Claude, accessible depuis GitHub Actions.
- `scripts/gen_tajweed.py` (lancé par `fetch-assets.sh` dans `pages.yml`) recale les positions sur notre texte (qui = ce texte + insertions) ; une ayah dont l'alignement n'est pas fait que d'insertions n'est pas colorée.
- Test de la logique : `python3 tests/gen_tajweed_test.py <dossier avec public/quran.json et src/word-overrides.json>`.

## IndoPak (à faire)
Recommandé : DigitalKhatt (Tarteel).
- Police OFL 1.1 : `https://raw.githubusercontent.com/DigitalKhatt/digitalkhatt-js/main/apps/site-angular/src/assets/fonts/coretext/DigitalKhattIndoPak.ttf` (convertir en woff2 avec fonttools).
- Texte (dépôt MIT) : `.../apps/site-angular/src/app/services/quran_text_indopak_15.ts`, rangé par page / ligne (mushaf 15 lignes). Découper sur `۝` + chiffres arabes.
- Nombre de mots identique au nôtre pour 6231 ayahs sur 6236 (exceptions : 2:181, 8:6, 13:37, 37:130, 72:16 : garder l'Uthmani pour ces ayahs).
- Attention : codepoints spéciaux (U+034F, U+202E, U+08xx) : ne s'affiche correctement qu'avec cette police. Tester le rendu sur Chrome Android.
- À éviter : police IndoPak de QuranWBW / quran.com (licence « not for distribution »).
- Ces informations viennent d'une recherche web (octobre 2026) : revérifier les URL et le nombre de mots avant d'intégrer.

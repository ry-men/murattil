# Serveur tajwid Murattil (Quran Muaalem)

Analyse fine d'une récitation : lettres (harf), harakat, règles de tajwid (madd, ghunna, qalqala…).
Modèle : [Quran Muaalem](https://github.com/obadx/quran-muaalem) (MIT), Wav2Vec2-BERT 605 M paramètres.

## Lancer

```sh
docker build -t murattil-tajwid server/
docker run -p 7860:7860 murattil-tajwid
```

- CPU : 4 Go de RAM conseillés, 1 à 3 s par segment de 10 s.
- GPU : automatique si CUDA est disponible.
- HTTPS obligatoire si l'app est servie en HTTPS (GitHub Pages) : reverse proxy (Caddy, Traefik) ou Hugging Face Spaces.

## Modal (GPU, recommandé pour le tajwid en direct)

- GPU T4, facturé à la seconde, s'éteint après 2 min sans requête. Coût : environ 0,6 $/h de T4 + CPU/RAM, soit 3 à 5 centimes par réveil. Les 30 $ de crédits mensuels gratuits de Modal couvrent largement un usage personnel.
- Réponse en moins d'une seconde par ayah une fois le serveur chaud ; démarrage à froid d'environ 20 à 40 s (l'app réveille le serveur dès l'ouverture d'une séance).

1. Créer un compte sur modal.com (connexion GitHub, sans carte).
2. Settings → API Tokens → New token : noter `token-id` et `token-secret`.
3. Dans le dépôt GitHub : Settings → Secrets → Actions : `MODAL_TOKEN_ID` et `MODAL_TOKEN_SECRET`.
4. Le workflow `.github/workflows/modal.yml` déploie tout seul, écrit l'adresse du serveur dans `public/config.json` et republie le site. L'app utilise ce serveur automatiquement : rien à coller. (Réglages Hifz → Avancé : pour forcer un autre serveur.)

## Hugging Face Spaces (CPU, plus lent)

Attention : la création d'un Space Docker demande désormais un abonnement payant (PRO).

1. Sur huggingface.co : New Space → SDK **Docker** → Blank → Public.
2. Dans l'onglet Files, créer les 2 fichiers du dossier `server/hf-space/` (`README.md` et `Dockerfile`), copiés tels quels.
3. Attendre la construction (10 à 15 min la première fois).
4. Mettre l'adresse du Space (`https://<compte>-<nom>.hf.space`) dans `public/config.json` (champ `tajwidUrl`), ou dans l'app : Hifz → Avancé.

## Image Docker prête (GitHub Actions)

Le workflow `.github/workflows/server.yml` publie `ghcr.io/ry-men/murattil-tajwid:latest` (paquet à rendre public dans GitHub si besoin) :

```sh
docker run -p 7860:7860 ghcr.io/ry-men/murattil-tajwid:latest
```

## API

`POST /analyze` (multipart) : `file` (WAV 16 kHz), `surah`, `ayah_from`, `ayah_to`, `basmala` (0/1), `sifat` (0/1).
Avec `sifat=1` et une seule ayah (40 s max) : analyse aussi les caractéristiques des lettres (mode Atelier).
Réponse : par ayah, la liste des erreurs `{word, word_text, category: harf|haraka|tajwid|mot|sifa, message}`.

## Calibration

Mesurée sur 126 ayahs de 7 récitateurs pros (toute faute signalée y est fausse), API complète, une ayah par requête :

| Réglage | Fausses fautes / ayah (pros) | Points / ayah (Ryan) |
|---|---|---|
| Sans aucun filtre | 0,55 | 4 |
| Souple (`min_delta=8`) | 0,05 | 1,65 |
| Normal (`min_delta=4`, défaut) | 0,08 | 2,08 |
| Strict (`min_delta=1`) | 0,17 | 2,57 |
| Sifat (Atelier), avant / après `SIFA_RULES` | 0,84 / 0,02 | |

Filtre de confiance : pour chaque faute, delta = log P(version fautive) - log P(version correcte) (CTC).
Familles bruitées (`EXTRA_DELTA`) : seuil plus haut. Rejouer : `python tests/llr_eval.py pros` (modèle sur CPU).

## Tests (sans modèle)

```sh
python test_analysis.py && python test_app.py
```

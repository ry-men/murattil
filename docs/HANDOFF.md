# Murattil : passation (à lire en premier dans une nouvelle session)

App perso, non commerciale, de récitation / hifz du Coran (alternative à Tarteel). PWA Vite + TypeScript.
Dépôt : `ry-men/murattil` (public). Site : GitHub Pages (workflow `pages.yml`). Utilisateur : Ryan (Android 16, Chrome).

## Préférences de Ryan
- Réponses en français, puces très simples, phrases sujet-verbe-complément, concis.
- Automatiser au maximum plutôt que donner des étapes manuelles.
- Jamais Vercel (Docker, Modal, GitHub Pages OK).
- Coran : ne jamais inventer de texte ni de données. Sources publiées et vérifiées seulement.

## Architecture
| Couche | Rôle | Fichiers |
|---|---|---|
| Suivi en direct : Zipformer (Tilawa, NPL non commercial) | mot par mot, hors ligne | `src/core`, `src/worker.ts` |
| Double vérification : FastConformer | réécoute chaque ayah, repêche les mots | `src/verify-worker.ts` |
| Tajwid léger : muaalem-mini (116 M, int8 ONNX, AGPL) | phonèmes CTC sur le téléphone | `src/mini/*` |
| Tajwid complet : Quran Muaalem (605 M) | serveur GPU Modal, sifat en mode Atelier | `server/` |

- PWA (v0.6.5, `src/pwa.ts`) : carte « Installer Murattil » sur l'accueil (beforeinstallprompt ; consigne Partager sur iPhone ;
  « Plus tard » = 14 jours), bandeau « Nouvelle version » (jamais de rechargement pendant une récitation), raccourcis
  d'icône `?go=hifz|libre|test|atelier|memo`, manifeste complet (id, captures d'écran, icône maskable, portrait).
- Modes : libre, hifz, test de mémoire, révision planifiée (`src/memo.ts`), points faibles, Atelier tajwid (ayah par ayah).
- Serveur : adresse écrite dans `public/config.json` par `modal.yml` (rien à saisir). Champ manuel dans Hifz → Avancé.
- Modèle mini : release `mini-v1` (workflow `export-mini.yml`, poids safetensors seulement, révision HF épinglée, aucun code distant). `fetch-assets.sh` le découpe en morceaux de 45 Mo + `muaalem_mini.parts.json` (clé de cache = sha).
- Service worker `public/sw.js` : cache, isolation COOP/COEP (multi-thread wasm), config.json et parts.json en réseau d'abord.
- La session « liée au dépôt » pousse le code (cette sandbox ne peut pas pousser). On lui donne un zip + un message.

## Constats importants (octobre 2026)
- muaalem-mini seul est trop bruité : ~1 fausse faute par ayah sur des récitateurs pros (Al-Mulk 1-4, An-Nas, 2:285).
  Un filtre de confiance (GOP, `tests/gop.py`) ne suffit pas : le modèle se trompe avec assurance.
  Décision v0.6 : on ne garde du mini que les fautes de lettres / mots oubliés confirmées par FastConformer
  (`corroborate()` dans `src/main.ts`). Harakat et madd du mini : ignorés.
- Madd : un écart d'un seul temps n'est plus signalé (serveur et mini).
- Gros modèle (serveur Modal `https://ry-men--murattil-tajwid-web.modal.run`), calibré le 6 oct. 2026 (v0.7.0) :
  - Référence : **663 ayahs de 34 récitateurs pros** (tarteel-ai/everyayah, split test). Toute faute y est fausse.
    (Sur 7 récitateurs on mesurait 0,08 : trop optimiste. Avec 34 : 0,22 avec les anciens seuils.)
  - Filtres : familles de bruit (`_model_noise` : bord, ghunna1, chadda, voyelle, confusion ; + madd_long) jugées par le
    filtre de confiance CTC (`confidence_filter`) avec un supplément de seuil (`EXTRA_DELTA` : bord 8, voyelle 6, madd_long 8).
    Seule la ghunna à 1 unité près est tolérée d'office. Reprises (3 insertions au même endroit) ignorées.
  - Sévérité (app, `SEVERITY_DELTA`) : souple 12 = 0,07 fausse faute / ayah, **normal 8 = 0,10**, strict 5 = 0,16.
    Chez Ryan (60 ayahs) : 1,27 / 1,55 / 1,83 points par ayah.
  - Sifat (Atelier) : seulement « lettre épaisse prononcée fine » (p >= 0,99) et « qalqala absente » (p >= 0,9) :
    0,05 / ayah chez les pros (toutes les sifat : 1,35).
  - Données et scripts : `tests/pros_eval.py` (mesure, modèle sur CPU ~1 h), `tests/pros_report.py` (rapport sans GPU),
    `tests/data/eval_pros.json` (résultats allégés).
  - Démarrage : `modal_app.py` en classe avec instantané mémoire (`enable_memory_snapshot`) : à vérifier au 1er déploiement.
  - transformers 5 casse quran-muaalem 0.2.2 : épinglé `<5`.
- Mini (téléphone) v0.7.0 : même filtre de confiance, porté en TS (`ctcLogLik`, `addConfidence` dans `src/mini/explain.ts`,
  log-probs dans `mini-worker.ts`). Seuil `MINI_DELTA` : souple 20, normal 16, strict 12.
  Mesuré sur les 663 ayahs avec la chaîne TS complète (`tests/mini_dump.py` + `tests/mini_ts_eval.ts`) :
  0,04 fausse faute / ayah au seuil 16 (0,02 harakat/tajwid + 0,02 lettres), avant FastConformer (lettres et mots
  oubliés passent en plus par `corroborate`). Harakat, madd, ghunna du mini de nouveau affichés (`filterMini`).
- Bouton « Pas une faute » (bilan de séance et Atelier) : `fp: true` sur la faute dans l'historique et le diagnostic,
  avec `confidence` et `noise` : sert à calibrer sur la voix de Ryan.
- Points de Ryan (cohérents d'une répétition à l'autre) : ghunna نّ/مّ trop courte, ikhfa / iqlab non faits,
  ر et ق trop fins, madd muttasil à 2 temps. 74:22 « وبصر ». À confirmer avec ses retours « Pas une faute ».
- Entraînement robuste au micro : plan dans `docs/entrainement.md` (distillation propre -> dégradé, pas encore lancé).
- Accès réseau : la sandbox Cowork joint `*.modal.run` et `huggingface.co` depuis le 5 oct. 2026 (domaines ajoutés par Ryan).
- Coût Modal (v0.6.1) : un réveil = démarrage + attente avant extinction, environ 3 à 5 centimes.
  L'écran de séance ne réveille plus le serveur quand le mini fait le tajwid en direct ; extinction après 2 min (au lieu de 5).
  Évaluation complète du 5 oct. (5 audios + 126 ayahs de pros) : moins de 2 min de GPU.

## v0.8.0 (15 nov. 2026) : expérience hifz, sans GPU
- Branche `claude/v0.8-best-in-class` (contient aussi v0.7.0, qui n'était pas encore dans le dépôt).
- Mode **Apprendre** (`session.learn` dans `src/main.ts`) : écouter -> lire -> de mémoire -> enchaîner. Fin automatique de l'étape
  quand la dernière ayah est complète (`session.autoEnd`). Passage appris : `prefs.learning` (fusion par `mergePassage`),
  ajouté aux unités de révision dans `memoStatuses()`. Sourate couverte en entier : passe dans `prefs.memorized`.
- **Progression** (`renderStats`, fonctions pures dans `src/memo.ts` : `juzProgress`, `activityGrid`, `minutesToday`). Objectif : `prefs.dailyGoalMin`.
- **Sauvegarde** : `src/backup.ts` + `exportData` / `importData` dans `src/store.ts`.
- **Calibrage personnel** : `src/calib.ts`. Règle assouplie si >= 3 retours « pas une faute » et >= 50 % des cas ; on masque alors les fautes
  dont la confiance <= la plus sûre des fausses fautes marquées. Même mot marqué 2 fois : masqué. Mots oubliés : jamais masqués par règle.
  Appliqué par `personal()` (direct, bilan, file d'attente, Atelier). Réglage `prefs.personalCalib`.
- **Révision** : `fromMemory()` : texte visible ou indices (> 3 % des mots) = pas de progression d'intervalle. `SessionRecord.display` ajouté.
- **Bilan** : `playRow()` : « Ma voix » (segment de l'audio de la séance) et « Récitateur » (`prefs.qari`, repli Alafasy).
- Version : `src/version.ts`. Cache du service worker : `murattil-v12`.
- Non vérifié ici (domaine bloqué dans la sandbox) : lecture réelle des MP3 everyayah.com, dossiers Husary / Minshawy / Abdul_Basit.
  En cas d'échec, l'app retombe sur Alafasy (déjà utilisé par l'Atelier).
- Pas touché : moteur de suivi, modèles, serveur Modal. Chuchotement : à mesurer avec des enregistrements de Ryan (bouton diagnostic).

## Tests utiles
- `npx tsx tests/memo.ts` : révision espacée, juz, calibrage, activité (12 tests, sans modèle). CI : `.github/workflows/tests.yml`.
- `node tests/e2e.mjs <wav> hifz <s> <de> <à>` (serveur `npx vite preview --port 4173`), `tests/atelier.mjs`, `tests/queue.mjs`, `tests/offline.mjs`.
- `python tests/mini_eval.py <wav> <s> <de> <à> [--tau -6] [--v]` : fautes du mini sur un enregistrement complet.
- `python tests/server_eval.py --url <serveur> <audios>` : fautes du gros modèle sur des enregistrements complets (une ayah à la fois).
- `python tests/pros_report.py [--mini]` : taux de fausses fautes par réglage, famille, récitateur (sans GPU).
- `python tests/calibrate.py` : ancien calibrage (126 ayahs, filtres durs seuls).
- `python tests/llr_eval.py pros|ryan` : delta de confiance par faute (modèle complet sur CPU, ~4 min pour 126 ayahs).
- `npx tsx tests/explain.ts`, `tests/features.ts`, `tests/mini_onnx.ts`, `server/test_analysis.py`.
- Faux serveur : `uvicorn --app-dir tests mock_tajwid:app --port 7860`.

## Pistes ouvertes
- Police IndoPak (DigitalKhatt, OFL) : sources dans `docs/fonts.md`. Couleurs du tajwid : faites (v0.6), générées dans `pages.yml`.
- Gros modèle : calibré sur 34 récitateurs (v0.7.0). Ensuite : retours « Pas une faute » de Ryan, puis `docs/entrainement.md`.

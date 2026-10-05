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
- Gros modèle (serveur Modal `https://ry-men--murattil-tajwid-web.modal.run`) évalué et calibré le 5 oct. 2026 :
  - Référence : 126 ayahs de 7 récitateurs pros (tarteel-ai/everyayah, split test) = fausses fautes.
  - Phonèmes : 0,55 fausse faute / ayah brut ; 0,21 après filtres v0.6.2 ; **0,06 après filtre de confiance v0.6.3**
    (1 fausse faute toutes les 16 ayahs). Chez Ryan (60 ayahs, découpées une par une comme l'app) : 1,6 point / ayah gardé.
  - v0.6.2 : filtres `FILTERS` / `_model_noise` (bord, ghunna à 1 unité près, voyelle avalée, ط→ق, reprises) + messages
    ghunna / ikhfa / iqlab / madd (`_ghunna`).
  - v0.6.3 : `confidence_filter()` : pour chaque faute, delta = log P(version fautive) - log P(version correcte) par CTC
    sur tout le segment (`Muaalem.logprobs` / `loglik`). Faute gardée si delta >= `min_delta` (champ de l'API).
    Delta médian : 1,3 chez les pros, 12 chez Ryan. Données : `tests/data/llr_pros.json`, script `tests/llr_eval.py`.
  - v0.6.4 : les familles bruitées ne sont plus retirées d'office mais jugées par la confiance (`FILTERS` à False,
    `WordError.noise`), avec un seuil plus haut : bord +8, voyelle avalée +4 (`EXTRA_DELTA`). Chadda oubliée et ط/ق
    de nouveau détectées. Seule la ghunna à 1 unité près reste tolérée d'office (marge de mesure, comme le madd).
  - Sévérité dans l'app (Réglages, `tjSeverity`) : souple = 8, normal = 4, strict = 1 (`SEVERITY_DELTA` dans `src/tajwid.ts`).
    Mesure via l'API complète, ayahs découpées une par une :
    souple : pros 0,05 / ayah, Ryan 1,65 · normal : pros 0,08, Ryan 2,08 · strict : pros 0,17, Ryan 2,57.
  - Sifat (Atelier) : 0,84 fausse faute / ayah chez les pros, même à 99 % de probabilité. v0.6.3 ne garde que
    « lettre épaisse prononcée fine » (p >= 0,99) et « qalqala absente » (p >= 0,9) : 0,02 / ayah chez les pros (`SIFA_RULES`).
  - transformers 5 casse quran-muaalem 0.2.2 : épinglé `<5` (requirements.txt, modal_app.py).
  - Points de Ryan (cohérents d'une répétition à l'autre) : ghunna نّ/مّ trop courte, ikhfa / iqlab non faits,
    ر et ق trop fins, madd muttasil à 2 temps, madd naturel trop long sur « الله ». 74:22 « وبصر » confirmé.
  - Prochaine étape : bouton « pas une faute » sur un mot signalé, exporté dans le diagnostic, pour calibrer sur la voix de Ryan.
- Accès réseau : la sandbox Cowork joint `*.modal.run` et `huggingface.co` depuis le 5 oct. 2026 (domaines ajoutés par Ryan).
- Coût Modal (v0.6.1) : un réveil = démarrage + attente avant extinction, environ 3 à 5 centimes.
  L'écran de séance ne réveille plus le serveur quand le mini fait le tajwid en direct ; extinction après 2 min (au lieu de 5).
  Évaluation complète du 5 oct. (5 audios + 126 ayahs de pros) : moins de 2 min de GPU.

## Tests utiles
- `node tests/e2e.mjs <wav> hifz <s> <de> <à>` (serveur `npx vite preview --port 4173`), `tests/atelier.mjs`, `tests/queue.mjs`, `tests/offline.mjs`.
- `python tests/mini_eval.py <wav> <s> <de> <à> [--tau -6] [--v]` : fautes du mini sur un enregistrement complet.
- `python tests/server_eval.py --url <serveur> <audios>` : fautes du gros modèle sur des enregistrements complets (une ayah à la fois).
- `python tests/calibrate.py` : effet de chaque filtre sur les pros (`tests/data/ref_pros_server.json`), sans GPU.
- `python tests/llr_eval.py pros|ryan` : delta de confiance par faute (modèle complet sur CPU, ~4 min pour 126 ayahs).
- `npx tsx tests/explain.ts`, `tests/features.ts`, `tests/mini_onnx.ts`, `server/test_analysis.py`.
- Faux serveur : `uvicorn --app-dir tests mock_tajwid:app --port 7860`.

## Pistes ouvertes
- Police IndoPak (DigitalKhatt, OFL) : sources dans `docs/fonts.md`. Couleurs du tajwid : faites (v0.6), générées dans `pages.yml`.
- Gros modèle : calibré (v0.6.3). Prochaine étape : retours « pas une faute » de Ryan pour calibrer sur sa voix.

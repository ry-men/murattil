# Murattil · مُرَتِّل

App web (PWA) de récitation et de mémorisation du Coran.
La reconnaissance vocale tourne **sur le téléphone**, sans serveur. Pas de coupure quand le réseau saute.

## Ce que fait la v0.6

- **Hifz · Révision** : choix d'une sourate et d'un passage. Le texte reste caché et se dévoile mot par mot pendant la récitation.
- **Erreurs signalées** : mot oublié, mot différent, haraka douteuse, ayah sautée. Feuille d'erreur avec « Reprendre l'ayah » ou « C'était correct ».
- **Récitation libre** : on récite n'importe où, l'app retrouve la sourate et suit chaque mot.
- **Indice** : dévoile le mot suivant en cas de blocage.
- **Bilan** : durée, ayahs, mots validés, mots à revoir (non reconnus ou faux probables). Historique sur l'appareil.
- **Diagnostic** : export de l'audio de la séance + journal du moteur, pour analyser un problème de reconnaissance.
- **Réglages** : détection sensible des erreurs (slip head), filtre anti-bruit du téléphone (coupé par défaut).
- **Double vérification** : un 2e modèle (FastConformer, MIT / CC-BY) réécoute chaque ayah et repêche les mots ratés par le moteur principal (surtout le début des ayahs). Sur un enregistrement réel : 93,6 % → 99,4 % de mots validés.
- **Analyse tajwid fine (facultative)** : après la séance, envoi de l'audio à un serveur [Quran Muaalem](https://github.com/obadx/quran-muaalem) (dossier `server/`) qui repère les fautes de lettres, de harakat et de tajwid (madd, ghunna…).
- **Serveur automatique** : l'adresse du serveur tajwid est écrite dans `public/config.json` par le workflow de déploiement Modal. L'utilisateur n'a rien à saisir.
- **Tajwid en direct (en ligne)** : chaque ayah terminée part au serveur Muaalem ; les fautes s'affichent sur le mot (souligné, touche le mot pour le détail). Hors ligne : les ayahs sont gardées sur le téléphone (IndexedDB) et analysées automatiquement au retour du réseau.
- **Tajwid hors ligne (muaalem-mini)** : un petit modèle (116 M param., ~120 Mo en int8) tourne sur le téléphone. Il repère lettres, harakat et madd ayah par ayah, sans réseau. Il est publié par le workflow `export-mini.yml` (release `mini-v1`) : poids safetensors seulement, révision épinglée, aucun code téléchargé exécuté. Le téléphone utilise plusieurs cœurs (isolation cross-origin par le service worker). Moteur au choix dans Hifz : auto, téléphone ou serveur.
- **Fiabilité du tajwid** : le modèle mini seul se trompe trop (testé sur des récitateurs professionnels). Ses fautes de lettres ne sont affichées que si le 2e modèle (FastConformer) les confirme ; ses harakat et madd sont ignorés. Un madd à un temps près n'est plus signalé.
- **Couleurs du tajwid** : texte coloré par règle (ghunna, ikhfa, idgham, iqlab, qalqala, madd…), données cpfair/quran-tajweed (CC-BY 4.0) recalées exactement sur le texte ; légende dans les réglages.
- **Atelier tajwid** : une ayah à la fois, en murattal. Analyse complète par le serveur Muaalem, avec les sifat (tafkhim, qalqala, ghunna…). Écoute de sa récitation et du récitateur (Alafasy), score, ayah suivante ou recommencer. Hors ligne : analyse par le modèle mini.
- **Test de mémoire** : début de verset tiré au hasard dans tes sourates, tu continues de mémoire, score par question.
- **Ma mémorisation + Révision du jour** : sourates déclarées, répétition espacée (1, 2, 4, 7, 14, 30, 60 jours), longues sourates découpées en portions.
- **Points faibles** : mots, ayahs et règles de tajwid qui reviennent sur tout l'historique, avec bouton « Réviser ».
- **Affichage** : caché, premières lettres, ou visible. Régularité (jours d'affilée, minutes de la semaine).
- **Robustesse** : modèle en cache (IndexedDB), app en cache (service worker), écran maintenu allumé, micro relancé tout seul après une coupure (appel, casque, mise en veille).

## Lancer en local

```sh
npm install
sh scripts/fetch-assets.sh   # modèle 69 Mo + données
npm run dev
```

## Déployer

- **GitHub Pages** : pousser sur `main`, le workflow `.github/workflows/pages.yml` construit et publie. Activer Pages en mode « GitHub Actions » dans les réglages du dépôt.
- **Docker** : `docker build -t murattil . && docker run -p 8080:80 murattil`. HTTPS obligatoire pour le micro (reverse proxy type Caddy ou Traefik).

## Tests

```sh
npx tsx tests/words.ts                                   # alignement texte / moteur sur les 6236 ayahs
npx tsx tests/node-run.ts <audio> correction 114 1 6     # rejoue un audio dans le moteur
node tests/e2e.mjs <wav> hifz 67 1 4 --show             # test navigateur avec micro simulé
node tests/atelier.mjs                                   # Atelier tajwid (serveur factice tests/mock_tajwid.py)
npx tsx tests/features.ts && npx tsx tests/explain.ts    # modèle mini : features audio et explication des fautes
npx tsx tests/mini_onnx.ts out                           # modèle mini exporté : chaîne navigateur = Python
```

## Architecture

| Couche | Rôle | Où |
|---|---|---|
| Interface (PWA) | Texte caché, suivi, bilan, historique | Téléphone |
| Moteur de suivi : Zipformer (Tilawa) | Suit la récitation en direct, mot par mot | Téléphone, hors ligne |
| Double vérification : FastConformer | Réécoute chaque ayah, repêche les mots ratés | Téléphone, hors ligne |
| Tajwid léger : muaalem-mini (116 M param., int8) | Lettres, harakat, madd | Téléphone, hors ligne |
| Tajwid complet : Quran Muaalem (605 M param., 2,4 Go) | Lettres, harakat, tajwid, sifat (Atelier) | Serveur GPU (Modal) ; file d'attente hors ligne |

## Licences

- Moteur `src/core` : [Tilawa](https://github.com/yazinsai/tilawa), code MIT (voir `LICENSE-tilawa`).
- Modèle Zipformer et corpus phonétique : **NPL-1.2, usage non commercial** (voir `NOTICE-tilawa.md`). Ils ne sont pas versionnés ici, le script les télécharge.
- Modèle FastConformer : NVIDIA CC-BY-4.0 / MIT (export Tilawa).
- Serveur `server/` : Quran Muaalem et quran-transcript, MIT.
- Modèle muaalem-mini (sysofwan/hifzguide-muaalem-mini) : AGPL-3.0. Usage personnel, non versionné ici.
- Police Amiri Quran : SIL OFL.

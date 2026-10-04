# Murattil · مُرَتِّل

App web (PWA) de récitation et de mémorisation du Coran.
La reconnaissance vocale tourne **sur le téléphone**, sans serveur. Pas de coupure quand le réseau saute.

## Ce que fait la v0.1

- **Hifz · Révision** : choix d'une sourate et d'un passage. Le texte reste caché et se dévoile mot par mot pendant la récitation.
- **Erreurs signalées** : mot oublié, mot différent, haraka douteuse, ayah sautée. Feuille d'erreur avec « Reprendre l'ayah » ou « C'était correct ».
- **Récitation libre** : on récite n'importe où, l'app retrouve la sourate et suit chaque mot.
- **Indice** : dévoile le mot suivant en cas de blocage.
- **Bilan** : durée, ayahs, erreurs, indices. Historique des séances sur l'appareil.
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
```

## Licences

- Moteur `src/core` : [Tilawa](https://github.com/yazinsai/tilawa), code MIT (voir `LICENSE-tilawa`).
- Modèle Zipformer et corpus phonétique : **NPL-1.2, usage non commercial** (voir `NOTICE-tilawa.md`). Ils ne sont pas versionnés ici, le script les télécharge.
- Police Amiri Quran : SIL OFL.

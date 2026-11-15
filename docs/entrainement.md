# Rendre le modèle tajwid robuste au micro du téléphone (plan, pas encore lancé)

## Le problème

- Sur 663 ayahs de 34 récitateurs pros (studio), le gros modèle se trompe peu : 0,10 fausse faute par ayah.
- Sur l'audio du téléphone de Ryan, il signale beaucoup plus. Une partie est de vraies fautes, une partie vient du micro.
- Preuve que le micro joue : les sifat (hams, shidda…) donnent 1,4 « faute » par ayah chez les pros et 16 chez Ryan.

## Pourquoi on ne peut pas entraîner sur le texte du Coran

- Les étiquettes « texte du mushaf » supposent une récitation parfaite.
- Un récitateur pro peut avoir de petites variantes (durée d'un madd, arrêt). Ryan fait des fautes.
- Entraîner sur ces étiquettes apprendrait au modèle à **ignorer les fautes**. À éviter.

## La méthode : apprendre « même résultat avec un mauvais micro »

- Professeur : le modèle actuel, figé, écoute l'audio **propre** du studio.
- Élève : une copie du modèle écoute le **même** audio, dégradé comme un téléphone
  (micro bas de gamme, bruit de pièce, écho, compression AAC/Opus, volume variable).
- L'élève apprend à donner **la même sortie que le professeur**, phonème par phonème (distillation).
- On n'utilise jamais le texte du Coran comme vérité : on s'en fiche qu'il y ait une petite variante chez le pro,
  l'élève copie ce que le professeur entend vraiment. Les fautes restent donc détectables.

## Données (publiques, déjà accessibles)

- tarteel-ai/everyayah : 36 récitateurs, environ 300 h (split train).
- Dégradations générées à la volée : pas de nouvelle donnée à collecter.
- Plus tard : les audios de Ryan **sans** étiquette, seulement pour la dégradation « vrai micro » (bruit de fond mesuré),
  jamais comme référence de récitation.

## Mesure (avant de remplacer quoi que ce soit)

- Fausses fautes chez les pros sur l'audio dégradé : doit baisser nettement.
- Fausses fautes chez les pros sur l'audio propre : ne doit pas monter.
- Fautes simulées (lettre changée, madd raccourci… injectées dans des phonèmes de pros, `server/test_analysis.py`) : détection identique.
- Si un seul critère se dégrade, on garde l'ancien modèle.

## Coût estimé

- GPU Modal A10G ou L4, environ 1 $/h. 10 à 25 h d'entraînement : 10 à 25 $ (dans les 30 $ de crédits mensuels).
- À lancer depuis la session liée au dépôt (jeton Modal dans les secrets GitHub), en plusieurs petites passes
  avec mesure entre chaque passe.

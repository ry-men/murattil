#!/usr/bin/env sh
# Télécharge le modèle et les données (non versionnés : licence NPL-1.2, usage non commercial).
set -eu
cd "$(dirname "$0")/../public"
mkdir -p models
get() { [ -s "$2" ] || curl -fL --retry 3 -o "$2" "$1"; }
get https://github.com/yazinsai/tilawa/releases/download/zipformer-a0w-ep1-a0.5/zipformer_a0w_ep1_a05.int8.onnx models/zipformer_a0w_ep1_a05.int8.onnx
get https://github.com/yazinsai/tilawa/releases/download/v0.3.0/zipformer_quran.json zipformer_quran.json
get https://github.com/yazinsai/tilawa/releases/download/v0.2.0/quran.json quran.json
get https://github.com/yazinsai/tilawa/releases/download/v0.2.0/fastconformer_full_mixed.onnx models/fastconformer_full_mixed.onnx
get https://github.com/yazinsai/tilawa/releases/download/v0.2.0/vocab.json models/fastconformer_vocab.json
# Facultatif : muaalem-mini (publié par le workflow export-mini) ; absent = fonction désactivée dans l'app.
REL=https://github.com/${GITHUB_REPOSITORY:-ry-men/murattil}/releases/download/mini-v1
# Découpé en morceaux de 45 Mo (limite de taille par fichier de l'hébergement) + manifeste lu par l'app.
if curl -fsL -o /tmp/muaalem_mini.int8.onnx "$REL/muaalem_mini.int8.onnx" && curl -fsL -o models/muaalem_mini_vocab.json "$REL/muaalem_mini_vocab.json"; then
  rm -f models/muaalem_mini.part*
  split -b 45m -d -a 2 /tmp/muaalem_mini.int8.onnx models/muaalem_mini.part
  SIZE=$(wc -c < /tmp/muaalem_mini.int8.onnx)
  PARTS=$(cd models && ls muaalem_mini.part?? | sed 's/.*/"&"/' | paste -sd, -)
  echo "{\"parts\":[$PARTS],\"size\":$SIZE}" > models/muaalem_mini.parts.json
  rm -f /tmp/muaalem_mini.int8.onnx
  echo "muaalem-mini : $(cat models/muaalem_mini.parts.json)"
else
  rm -f models/muaalem_mini_vocab.json; echo "muaalem-mini absent (pas encore exporté)"
fi
echo "Assets OK"

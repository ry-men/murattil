#!/usr/bin/env sh
# Télécharge le modèle et les données (non versionnés : licence NPL-1.2, usage non commercial).
set -eu
cd "$(dirname "$0")/../public"
mkdir -p models
get() { [ -s "$2" ] || curl -fL --retry 3 -o "$2" "$1"; }
get https://github.com/yazinsai/tilawa/releases/download/zipformer-a0w-ep1-a0.5/zipformer_a0w_ep1_a05.int8.onnx models/zipformer_a0w_ep1_a05.int8.onnx
get https://github.com/yazinsai/tilawa/releases/download/v0.3.0/zipformer_quran.json zipformer_quran.json
get https://github.com/yazinsai/tilawa/releases/download/v0.2.0/quran.json quran.json
echo "Assets OK"

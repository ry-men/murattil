"""Exporte la fenêtre de Povey et le banc de filtres mel (SeamlessM4T / Wav2Vec2-BERT) pour le calcul des
caractéristiques audio côté navigateur. Usage : python scripts/gen_mel.py > src/mini/mel.json"""
import json
import numpy as np
from transformers import SeamlessM4TFeatureExtractor

fe = SeamlessM4TFeatureExtractor()
mel = np.asarray(fe.mel_filters)  # (257, 80)
filters = []
for m in range(mel.shape[1]):
    col = mel[:, m]
    nz = np.nonzero(col)[0]
    start = int(nz[0]) if len(nz) else 0
    end = int(nz[-1]) + 1 if len(nz) else 0
    filters.append({"start": start, "w": [float(x) for x in col[start:end]]})
print(json.dumps({"window": [float(x) for x in np.asarray(fe.window)], "filters": filters}))

"""Serveur d'analyse tajwid pour Murattil (Quran Muaalem).

POST /analyze  (multipart)
  file       : WAV 16 kHz mono (un segment de récitation, idéalement 2 à 14 s)
  surah      : numéro de sourate
  ayah_from  : première ayah attendue dans le segment
  ayah_to    : dernière ayah attendue
  basmala    : "1" si le segment peut commencer par la basmala
  madd_monfasel_len, madd_mottasel_len, madd_aared_len : réglages Hafs (facultatifs)
-> { ayahs: [ {surah, ayah, coverage, errors: [ {word, word_text, category, message, ...} ]} ], predicted, ms }

GET /health -> { status, model_loaded }
"""
from __future__ import annotations

import io
import os
import time
import threading

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from analysis import MIN_DELTA, analyze_segment, confidence_filter, default_moshaf, to_json

app = FastAPI(title="Murattil · analyse tajwid (Quran Muaalem)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_model = None
_lock = threading.Lock()


def model():
    global _model
    with _lock:
        if _model is None:
            from model import Muaalem
            _model = Muaalem()
    return _model


@app.on_event("startup")
def warmup():
    # Chargement en tâche de fond : /health répond tout de suite, /analyze attend le modèle.
    threading.Thread(target=model, daemon=True).start()


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": _model is not None}


def _read_wave(data: bytes) -> np.ndarray:
    try:
        wave, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Audio illisible : {e}") from e
    if wave.ndim > 1:
        wave = wave.mean(axis=1)
    if sr != 16000:
        # rééchantillonnage linéaire simple (le client envoie déjà du 16 kHz)
        n = int(len(wave) * 16000 / sr)
        wave = np.interp(np.linspace(0, len(wave) - 1, n), np.arange(len(wave)), wave).astype(np.float32)
    return wave


@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    surah: int = Form(...),
    ayah_from: int = Form(...),
    ayah_to: int = Form(...),
    basmala: str = Form("0"),
    madd_monfasel_len: int = Form(4),
    madd_mottasel_len: int = Form(4),
    madd_aared_len: int = Form(4),
    sifat: str = Form("0"),
    min_delta: float = Form(MIN_DELTA),
):
    t0 = time.time()
    if not (1 <= surah <= 114) or ayah_from < 1 or ayah_to < ayah_from:
        raise HTTPException(422, "Passage invalide")
    wave = _read_wave(await file.read())
    if len(wave) < 0.4 * 16000:
        raise HTTPException(422, "Audio trop court")
    if len(wave) > 60 * 16000:
        raise HTTPException(413, "Segment trop long (60 s max)")
    from model import split_long
    m = model()
    moshaf = default_moshaf()
    moshaf = moshaf.model_copy(update={
        "madd_monfasel_len": madd_monfasel_len,
        "madd_mottasel_len": madd_mottasel_len,
        "madd_mottasel_waqf": max(madd_mottasel_len, 4),
        "madd_aared_len": madd_aared_len,
    })
    lp = None
    # Atelier : une seule ayah, analyse complète avec les sifat (tafkhim, qalqala, ghunna…).
    if sifat == "1" and ayah_from == ayah_to and len(wave) <= 40 * 16000 and hasattr(m, "analyze"):
        from analysis import _phonetize, ayah_text, sifat_errors
        ref = _phonetize(ayah_text(surah, ayah_from), moshaf, surah)
        predicted, pred_sifat, lp = m.analyze(wave, ref)
        results = analyze_segment(predicted, surah, ayah_from, ayah_to, moshaf, include_basmala=basmala == "1")
        if hasattr(m, "loglik"):
            confidence_filter(results, predicted, lambda t: m.loglik(lp, t), min_delta)
        for r in results:
            r.errors.extend(sifat_errors(pred_sifat, surah, r.ayah, moshaf))
    else:
        if hasattr(m, "logprobs"):
            lp = m.logprobs(wave)
            predicted = m.greedy(lp)
        else:  # ancien modèle / modèle de test
            predicted = "".join(m.phonemes(part) for part in split_long(wave))
        results = analyze_segment(predicted, surah, ayah_from, ayah_to, moshaf, include_basmala=basmala == "1")
        if lp is not None:
            # Filtre de confiance : on ne garde que les fautes que le modèle préfère nettement (voir analysis.py).
            confidence_filter(results, predicted, lambda t: m.loglik(lp, t), min_delta)
    return {"ayahs": to_json(results), "predicted": predicted, "ms": int((time.time() - t0) * 1000)}

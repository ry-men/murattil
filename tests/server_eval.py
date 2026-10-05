"""Évalue le serveur Muaalem complet (Modal) sur des enregistrements de Ryan.

    python tests/server_eval.py --url https://...modal.run audio1.aac audio2.aac [--passage 78:1-40]
    python tests/server_eval.py --reanalyze   # rejoue l'analyse sur les phonèmes déjà reçus (0 appel GPU)
    python tests/server_eval.py --selftest    # sans serveur : phonèmes de référence -> 0 faute attendue

1. Convertit chaque audio en WAV 16 kHz (ffmpeg), le coupe aux silences en morceaux de 55 s max.
2. Envoie chaque morceau à /analyze et garde seulement les phonèmes prédits (cache : tests/out/server_eval/*.json).
3. Trouve le passage (sourate:de-à) parmi les candidats, retrouve chaque ayah dans l'enregistrement
   et l'analyse en local avec server/analysis.py (même code que le serveur, une ayah à la fois comme l'app).
4. Affiche les fautes par catégorie et par mot.
Dépendances : ffmpeg, quran-transcript, Levenshtein, numpy, requests (pas de torch).
"""
from __future__ import annotations

import argparse
import io
import json
import subprocess
import sys
import time
import wave
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
from analysis import analyze_segment, ayah_text, default_moshaf, _phonetize, num_ayat  # noqa: E402

SR = 16000
OUT = ROOT / "tests" / "out" / "server_eval"
# Passages récités le 5 octobre 2026 (journaux de séance de l'app).
CANDIDATES = ["61:1-14", "78:1-40", "67:12-13", "70:24-25", "74:21-22"]


def load_audio(path: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768


def split_quiet(w: np.ndarray, max_s: float = 55.0) -> list[np.ndarray]:
    """Même logique que server/model.py:split_long : coupe au point le plus calme."""
    if len(w) <= max_s * SR:
        return [w]
    hop = int(0.02 * SR)
    energy = np.sqrt(np.convolve(w ** 2, np.ones(hop) / hop, mode="same"))
    parts, start = [], 0
    while len(w) - start > max_s * SR:
        lo, hi = start + int(0.6 * max_s * SR), start + int(max_s * SR)
        cut = lo + int(np.argmin(energy[lo:hi]))
        parts.append(w[start:cut])
        start = cut
    parts.append(w[start:])
    return parts


def to_wav(w: np.ndarray) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(SR)
        f.writeframes((np.clip(w, -1, 1) * 32767).astype(np.int16).tobytes())
    return buf.getvalue()


def phonemes_from_server(url: str, w: np.ndarray) -> tuple[str, list[int]]:
    import requests
    base = url.rstrip("/")
    for i in range(6):  # réveil (démarrage à froid ~40 s)
        try:
            if requests.get(base + "/health", timeout=90).json().get("model_loaded"):
                break
        except Exception:  # noqa: BLE001
            pass
        time.sleep(15)
    preds, ms = [], []
    for part in split_quiet(w):
        if len(part) < 0.5 * SR:
            continue
        r = requests.post(base + "/analyze", files={"file": ("seg.wav", to_wav(part), "audio/wav")},
                          data={"surah": 1, "ayah_from": 1, "ayah_to": 7}, timeout=300)
        r.raise_for_status()
        j = r.json()
        preds.append(j["predicted"]); ms.append(j["ms"])
    return "".join(preds), ms


def parse(p: str) -> tuple[int, int, int]:
    s, rng = p.split(":")
    a, b = (rng.split("-") + [rng])[:2]
    return int(s), int(a), int(b)


def best_passage(pred: str, cands: list[str]) -> tuple[str, float]:
    scores = []
    for c in cands:
        s, a, b = parse(c)
        res = analyze_segment(pred, s, a, b, include_basmala=a == 1, min_coverage=0)
        cov = sum(r.coverage for r in res) / max(1, b - a + 1)
        scores.append((cov, c))
    cov, c = max(scores)
    return c, cov


def best_slice(ref: str, pred: str) -> tuple[float, int, int]:
    """Meilleur passage de pred pour une ayah (l'élève peut répéter ou reprendre)."""
    import Levenshtein
    L, best = len(ref), (0.0, 0, 0)
    for i in range(0, max(1, len(pred) - int(L * 0.6))):
        for w in range(int(L * 0.75), int(L * 1.3) + 1, 2):
            r = Levenshtein.ratio(ref, pred[i:i + w])
            if r > best[0]:
                best = (r, i, i + w)
    return best


def report(name: str, pred: str, passage: str) -> dict:
    """Découpe par ayah (comme l'app, qui envoie une ayah à la fois), puis analyse chaque ayah."""
    s, a, b = parse(passage)
    m = default_moshaf()
    cats, words, nwords, low = Counter(), set(), 0, []
    lines = []
    for ay in range(a, b + 1):
        nwords += len(ayah_text(s, ay).split())
        r, i, j = best_slice(_phonetize(ayah_text(s, ay), m, s).phonemes, pred)
        res = analyze_segment(pred[max(0, i - 6):j + 6], s, ay, ay) if r >= 0.6 else []
        if not res:
            low.append(ay); continue
        for e in res[0].errors:
            cats[e.category] += 1; words.add((ay, e.word))
            lines.append(f"  {s}:{ay} mot {e.word} {e.word_text} [{e.category}] {e.message}")
    print(f"\n=== {name} : {passage} · {b - a + 1 - len(low)}/{b - a + 1} ayahs · {sum(cats.values())} fautes "
          f"sur {len(words)} mots / {nwords} · {dict(cats)}")
    print("\n".join(lines))
    if low:
        print(f"  ayahs non retrouvées : {low}")
    return {"passage": passage, "errors": sum(cats.values()), "words": len(words), "nwords": nwords, "cats": dict(cats)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", nargs="*")
    ap.add_argument("--url")
    ap.add_argument("--passage", help="ex. 78:1-40 (sinon détecté parmi les candidats)")
    ap.add_argument("--reanalyze", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    if a.selftest:
        m = default_moshaf()
        for p in CANDIDATES:
            s, x, y = parse(p)
            pred = "".join(_phonetize(ayah_text(s, k), m, s).phonemes for k in range(x, y + 1))
            found, cov = best_passage(pred, CANDIDATES)
            r = report("selftest", pred, found)
            assert found == p and r["errors"] == 0, (p, found, r)
        print("\nselftest OK")
        return

    caches = sorted(OUT.glob("*.json")) if a.reanalyze else []
    for f in a.audio:
        path = Path(f)
        cache = OUT / (path.stem + ".json")
        if cache.exists():
            caches.append(cache); continue
        if not a.url:
            sys.exit("--url manquant")
        w = load_audio(path)
        t0 = time.time()
        pred, ms = phonemes_from_server(a.url, w)
        cache.write_text(json.dumps({"audio": path.name, "seconds": round(len(w) / SR, 1), "predicted": pred,
                                     "server_ms": ms, "wall_s": round(time.time() - t0, 1)}, ensure_ascii=False))
        caches.append(cache)
    summary = []
    for c in caches:
        d = json.loads(c.read_text())
        passage = a.passage or best_passage(d["predicted"], CANDIDATES)[0]
        r = report(d["audio"], d["predicted"], passage)
        r.update(audio=d["audio"], seconds=d["seconds"], server_ms=sum(d["server_ms"]))
        summary.append(r)
    (OUT / "summary.txt").write_text(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()

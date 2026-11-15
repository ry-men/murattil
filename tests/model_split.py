"""split_long sans torch (copie de server/model.py) pour les scripts de test."""
import numpy as np

SR = 16000


def split_long(wave: np.ndarray, max_s: float = 14.0) -> list:
    if len(wave) <= max_s * SR:
        return [wave]
    hop = int(0.02 * SR)
    energy = np.sqrt(np.convolve(wave ** 2, np.ones(hop) / hop, mode="same"))
    parts, start = [], 0
    while len(wave) - start > max_s * SR:
        lo, hi = start + int(0.6 * max_s * SR), start + int(max_s * SR)
        cut = lo + int(np.argmin(energy[lo:hi]))
        parts.append(wave[start:cut])
        start = cut
    parts.append(wave[start:])
    return parts

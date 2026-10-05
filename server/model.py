"""Chargement de Quran Muaalem (Wav2Vec2-BERT, multi-level CTC) et transcription en phonèmes."""
from __future__ import annotations

import os
import numpy as np
import torch
from transformers import AutoFeatureExtractor
from quran_muaalem.modeling.modeling_multi_level_ctc import Wav2Vec2BertForMultilevelCTC
from quran_muaalem.modeling.multi_level_tokenizer import MultiLevelTokenizer

MODEL = os.environ.get("MUAALEM_MODEL", "obadx/muaalem-model-v3_2")
SR = 16000
MAX_SECONDS = 15.0


class Muaalem:
    def __init__(self, name: str = MODEL):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        # GPU : bfloat16 (entraînement d'origine) si supporté, sinon float16 (ex. T4) ; CPU : float32.
        if self.device == "cuda":
            self.dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        else:
            self.dtype = torch.float32
        torch.set_num_threads(max(1, os.cpu_count() or 1))
        self.processor = AutoFeatureExtractor.from_pretrained(name)
        self.tokenizer = MultiLevelTokenizer(name)
        self.model = Wav2Vec2BertForMultilevelCTC.from_pretrained(name).to(self.device, dtype=self.dtype).eval()
        self.vocab = self.tokenizer.id_to_vocab["phonemes"]
        self.ids = {c: int(i) for i, c in self.vocab.items() if int(i) != 0}

    @torch.inference_mode()
    def analyze(self, wave: np.ndarray, ref_out):
        """Phonèmes + caractéristiques des lettres (sifat) alignées sur la référence (mode Atelier).
        Reprend quran_muaalem.inference.Muaalem.__call__ avec le modèle déjà chargé."""
        from quran_transcript import chunck_phonemes
        from quran_muaalem.decode import multilevel_greedy_decode, phonemes_level_greedy_decode
        from quran_muaalem.inference import format_sifat
        level_to_ref_ids = self.tokenizer.tokenize([ref_out.phonemes], [ref_out.sifat], to_dict=True, return_tensors="pt", padding="longest")["input_ids"]
        feats = self.processor([wave], sampling_rate=SR, return_tensors="pt")
        feats = {k: v.to(self.device, dtype=self.dtype) for k, v in feats.items()}
        outs = self.model(**feats, return_dict=False)[0]
        probs = {lvl: torch.nn.functional.softmax(outs[lvl], dim=-1).cpu().to(torch.float32) for lvl in outs}
        ph_units = phonemes_level_greedy_decode(probs["phonemes"], self.tokenizer.id_to_vocab["phonemes"])
        chunked = [chunck_phonemes(u.text) for u in ph_units]
        level_to_units = multilevel_greedy_decode(
            level_to_probs=probs, level_to_id_to_vocab=self.tokenizer.id_to_vocab, level_to_ref_ids=level_to_ref_ids,
            chunked_phonemes_batch=chunked, ref_chuncked_phonemes_batch=[[x.phonemes for x in ref_out.sifat]], phonemes_units=ph_units,
        )
        sifat = format_sifat(level_to_units, chunked, self.tokenizer)[0]
        return ph_units[0].text, sifat, torch.log(probs["phonemes"][0].clamp_min(1e-12))

    @torch.inference_mode()
    def logprobs(self, wave: np.ndarray) -> torch.Tensor:
        """Log-probabilités des phonèmes (T x V, float32 sur CPU), audio découpé en morceaux de 14 s max."""
        out = []
        for part in split_long(wave):
            feats = self.processor(part, sampling_rate=SR, return_tensors="pt")
            feats = {k: v.to(self.device, dtype=self.dtype) for k, v in feats.items()}
            logits = self.model(**feats, return_dict=False)[0]["phonemes"][0]
            out.append(torch.log_softmax(logits.float(), dim=-1).cpu())
        return torch.cat(out)

    def greedy(self, lp: torch.Tensor) -> str:
        out, prev = [], 0
        for i in lp.argmax(-1).tolist():
            if i != 0 and i != prev:
                out.append(self.vocab[int(i)])
            prev = i
        return "".join(out)

    def loglik(self, lp: torch.Tensor, text: str) -> float:
        """log P(text | audio) par CTC (blank = 0)."""
        ids = [self.ids[c] for c in text if c in self.ids]
        if not ids or len(ids) > lp.shape[0]:
            return -1e9
        tgt = torch.tensor(ids)
        loss = torch.nn.functional.ctc_loss(lp.unsqueeze(1), tgt.unsqueeze(0), torch.tensor([lp.shape[0]]), torch.tensor([len(ids)]),
                                            blank=0, reduction="sum", zero_infinity=True)
        return -float(loss)

    def phonemes(self, wave: np.ndarray) -> str:
        """Phonèmes (rasm phonétique de quran-transcript)."""
        return self.greedy(self.logprobs(wave))


def split_long(wave: np.ndarray, max_s: float = 14.0) -> list[np.ndarray]:
    """Coupe un audio trop long aux points les plus calmes (fenêtres de 20 ms)."""
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

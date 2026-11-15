"""Exporte les log-probabilités du mini (ONNX int8) pour rejouer la chaîne TypeScript du téléphone.
    MINI_DIR=... REF_DIR=... python tests/mini_dump.py <dossier_sortie>
Sortie : index.json (sourate, ayah, récitateur, pred, T, V, fichier) + un .f32 de log-probs par ayah."""
import json, os, sys
import numpy as np, soundfile as sf
from pathlib import Path
__file__ = str(Path(__file__).resolve())
sys.argv = [sys.argv[0], "none", *sys.argv[1:]]
exec(open(Path(__file__).with_name("mini_llr_eval.py")).read().replace('{"pros": pros, "ryan": ryan}[sys.argv[1]]()', ""))
out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
idx = []
for k, m in enumerate(json.load(open(os.path.join(os.environ["REF_DIR"], "meta.json")))):
    w, _ = sf.read(os.path.join(os.environ["REF_DIR"], m["file"]), dtype="float32")
    lp = logprobs(w); pred, _ = greedy(lp)
    f = f"{k}.f32"; lp.numpy().astype(np.float32).tofile(out / f)
    idx.append({"surah": m["surah"], "ayah": m["ayah"], "reciter": m["reciter"], "pred": pred, "T": lp.shape[0], "V": lp.shape[1], "file": f})
json.dump({"vocab": VOCAB, "items": idx}, open(out / "index.json", "w"), ensure_ascii=False)
print(len(idx))

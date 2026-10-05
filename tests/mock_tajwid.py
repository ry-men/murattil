"""Faux serveur tajwid pour tester l'app : « récitation » parfaite sauf 78:4 mot 0 (lettre ك -> ق)."""
import sys; sys.path.insert(0, "server")
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from analysis import analyze_segment, ayah_text, _phonetize, default_moshaf, to_json
app = FastAPI(); app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
CALLS = []
@app.get("/health")
def health(): return {"status": "ok", "model_loaded": True}
@app.post("/analyze")
async def analyze(file: UploadFile = File(...), surah: int = Form(...), ayah_from: int = Form(...), ayah_to: int = Form(...), basmala: str = Form("0"), sifat: str = Form("0")):
    data = await file.read()
    CALLS.append((surah, ayah_from, ayah_to, len(data)))
    open(f"/tmp/claude-0/segs/{surah}_{ayah_from:03d}_{ayah_to:03d}.wav", "wb").write(data)
    m = default_moshaf()
    pred = "".join(_phonetize(ayah_text(surah, a), m, surah).phonemes.replace("كَ", "قَ", 1) if a == 4 else _phonetize(ayah_text(surah, a), m, surah).phonemes for a in range(ayah_from, ayah_to + 1))
    print("segment", surah, ayah_from, ayah_to, f"{(len(data)-44)/32000:.1f}s", flush=True)
    out = to_json(analyze_segment(pred, surah, ayah_from, ayah_to, m))
    if sifat == "1":
        for r in out:
            r["errors"].append({"word": 1, "word_text": "", "category": "sifa", "message": "Tafkhim : lettre trop légère (test)", "expected": "", "got": ""})
    return {"ayahs": out, "predicted": pred, "ms": 1}

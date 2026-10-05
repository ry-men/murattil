"""Test de l'API avec un faux modèle (aucun téléchargement) : vérifie le contrat JSON."""
import io, sys, types
import numpy as np, soundfile as sf
from analysis import ayah_text, _phonetize, default_moshaf

fake = types.ModuleType("model")
class FakeMuaalem:
    def phonemes(self, wave):
        m = default_moshaf()
        ph = lambda a: _phonetize(ayah_text(78, a), m, 78).phonemes
        return ph(3) + ph(4).replace("كَ", "قَ", 1) + ph(5)
fake.Muaalem = FakeMuaalem
fake.split_long = lambda w: [w]
sys.modules["model"] = fake

from fastapi.testclient import TestClient
import app as server
server._model = FakeMuaalem()
c = TestClient(server.app)
assert c.get("/health").json()["model_loaded"] is True
buf = io.BytesIO(); sf.write(buf, np.zeros(16000 * 3, dtype=np.float32), 16000, format="WAV"); buf.seek(0)
r = c.post("/analyze", files={"file": ("a.wav", buf, "audio/wav")}, data={"surah": 78, "ayah_from": 3, "ayah_to": 5})
assert r.status_code == 200, r.text
j = r.json()
print([(a["ayah"], a["coverage"], [(e["word"], e["category"], e["message"]) for e in a["errors"]]) for a in j["ayahs"]])
assert [a["ayah"] for a in j["ayahs"]] == [3, 4, 5]
assert j["ayahs"][1]["errors"][0]["category"] == "harf"
print("API OK")

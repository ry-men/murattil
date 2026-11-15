"""Déploiement GPU sur Modal (serverless, facturé à la seconde, s'éteint tout seul 2 min après la dernière requête).

    cd server && modal deploy modal_app.py
URL : https://<compte>--murattil-tajwid-web.modal.run, écrite toute seule dans public/config.json par le workflow modal.yml.
"""
import modal

MODEL = "obadx/muaalem-model-v3_2"


def download_model():
    # Les poids (2,4 Go) sont intégrés à l'image : démarrage à froid sans téléchargement.
    from transformers import AutoFeatureExtractor
    from quran_muaalem.modeling.modeling_multi_level_ctc import Wav2Vec2BertForMultilevelCTC
    from quran_muaalem.modeling.multi_level_tokenizer import MultiLevelTokenizer
    AutoFeatureExtractor.from_pretrained(MODEL)
    MultiLevelTokenizer(MODEL)
    Wav2Vec2BertForMultilevelCTC.from_pretrained(MODEL)


image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("libsndfile1")
    .pip_install(
        "torch>=2.7.0", "transformers>=4.55.0,<5", "quran-muaalem==0.2.2", "quran-transcript>=0.6.4",
        "fastapi>=0.116", "python-multipart>=0.0.20", "soundfile>=0.12", "numpy>=2.2", "Levenshtein>=0.27",
    )
    .run_function(download_model)
    .add_local_python_source("analysis", "model", "app")
)

app = modal.App("murattil-tajwid", image=image)


# Instantané mémoire : le modèle est chargé une fois sur CPU, Modal garde la mémoire du conteneur,
# puis chaque démarrage restaure cet instantané et passe le modèle sur le GPU (quelques secondes au lieu de ~40 s).
# Pendant l'instantané, aucun appel CUDA (Muaalem(device="cpu")) : sinon CUDA croit qu'il n'y a pas de GPU.
@app.cls(gpu="T4", scaledown_window=120, timeout=600, max_containers=1, enable_memory_snapshot=True)
@modal.concurrent(max_inputs=8)
class Tajwid:
    @modal.enter(snap=True)
    def load(self):
        import app as server
        from model import Muaalem
        server._model = Muaalem(device="cpu")

    @modal.enter(snap=False)
    def to_gpu(self):
        import torch
        import app as server
        if torch.cuda.is_available():
            server._model.to_device("cuda")

    @modal.asgi_app(label="murattil-tajwid-web")  # même adresse qu'avant : https://<compte>--murattil-tajwid-web.modal.run
    def web(self):
        import app as server
        return server.app

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


@app.function(gpu="T4", scaledown_window=120, timeout=600, max_containers=1)
@modal.concurrent(max_inputs=8)
@modal.asgi_app()
def web():
    import app as server
    server.model()  # charge le modèle tout de suite (requêtes suivantes rapides)
    return server.app

# Serveur d'analyse tajwid (Quran Muaalem) pour Murattil.
# CPU par défaut (4 Go de RAM conseillés). Compatible Hugging Face Spaces (Docker, port 7860).
#   docker build -t murattil-tajwid server/ && docker run -p 7860:7860 murattil-tajwid
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 app
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --chown=app:app *.py ./
USER app
ENV HF_HOME=/home/app/.cache/huggingface PORT=7860
# Télécharge le modèle pendant la construction (démarrage plus rapide). PRELOAD=0 pour sauter.
ARG PRELOAD=1
RUN if [ "$PRELOAD" = "1" ]; then python -c "from model import Muaalem; Muaalem()"; fi
EXPOSE 7860
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]

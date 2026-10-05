# Space Hugging Face (Docker) : construit le serveur tajwid depuis le dépôt GitHub public de Murattil.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git libsndfile1 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 app
WORKDIR /app
RUN git clone --depth 1 https://github.com/ry-men/murattil /tmp/m && cp /tmp/m/server/*.py /tmp/m/server/requirements.txt /app/ && rm -rf /tmp/m && chown -R app:app /app
RUN pip install --no-cache-dir -r requirements.txt
USER app
ENV HF_HOME=/home/app/.cache/huggingface PORT=7860
RUN python -c "from model import Muaalem; Muaalem()"
EXPOSE 7860
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]

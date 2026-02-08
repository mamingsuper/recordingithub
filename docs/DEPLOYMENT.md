# Deployment Guide

This project is optimized for macOS Apple Silicon (MLX + Senko).

`senko` 依赖来自 GitHub，因此部署机需要可访问 GitHub。

## 1. Provisioning

```bash
git clone <your-repo-url>
cd <repo-dir>
brew install ffmpeg
npm install
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -c "import mlx_whisper, senko; print('python deps ok')"
```

## 2. Runtime config

```bash
cp .env.example .env
set -a && source .env && set +a
```

Recommended overrides in production shell:

```bash
export PORT=3000
export DATA_DIR="$PWD/data"
export HF_HOME="$PWD/.cache/huggingface"
export PYTHON_EXECUTABLE="$PWD/.venv/bin/python"
```

## 3. Start service

```bash
npm start
```

Open: `http://localhost:3000`

## 4. Keep alive (optional)

```bash
npm install -g pm2
pm2 start server.js --name audio-transcriber
pm2 save
pm2 startup
```

## 5. Reverse proxy notes

Put Nginx/Caddy in front for TLS.

For SSE endpoint (`/api/progress/:clientId`), disable proxy buffering.

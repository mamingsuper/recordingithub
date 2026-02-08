# Audio Transcription Web Tool (MLX Whisper + Senko)

[English](#english) | [中文](#中文)

<a id="english"></a>

## English Description

A web-based audio transcription tool ready for deployment, supporting:
- Drag-and-drop audio upload
- Real-time progress updates (SSE)
- Speaker Diarization (Senko)
- Merged output by speaker turns (reduces fragmentation)
- Export to `JSON / TXT / Markdown`

### 1. System Requirements

Recommended Environment (default configuration):
- macOS (Apple Silicon, M1/M2/M3)
- Node.js 18+
- Python 3.10+ (3.12 Recommended)
- FFmpeg

Install FFmpeg:
```bash
brew install ffmpeg
```

### 2. Installation & Startup (Execute in order)

Run in the project root directory:

```bash
# Enter project root
cd your-project-directory

# 1) Node dependencies
npm install

# 2) Python virtual environment (Recommended 3.12)
python3.12 -m venv .venv
source .venv/bin/activate

# 3) Python dependencies
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

# 4) Verify critical dependencies
python -c "import mlx_whisper, senko; print('python deps ok')"

# 5) Start
npm run dev
# or npm start
```

Access via browser: `http://localhost:3000`

### 3. Usage Instructions

1. Open the page and upload an audio file (mp3/wav/m4a/webm/ogg/flac).
2. Select language, model, output format, and check speaker diarization if needed.
3. Click "Start Transcription" and wait for progress to complete.
4. The results page supports copying, downloading, and displaying merged speaker segments.

Transcriptions are saved by default in:
- `data/transcriptions/`

Temporary upload directory:
- `data/uploads/`

### 4. Environment Variables (Optional)

`server.js` defaults to prioritizing `.venv/bin/python` within the project; usually, no additional configuration is required.

To customize, you can set:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `PYTHON_EXECUTABLE` | Auto-detects `.venv/bin/python` | Python interpreter path |
| `TRANSCRIBE_SCRIPT` | `./scripts/transcribe_senko.py` | Transcription script path |
| `DATA_DIR` | `./data` | Runtime data directory |
| `HF_HOME` | `./.cache/huggingface` | Model cache directory |
| `MERGE_MAX_GAP_SECONDS` | `15` | Max gap (seconds) for merging same-speaker segments |
| `MERGE_MAX_CHARS` | `1200` | Max characters per merged segment |

If you use `.env`:
```bash
cp .env.example .env
set -a && source .env && set +a
```

### 5. FAQ

#### Q1: `No module named 'mlx_whisper'` error after startup
This indicates the Python environment used by the service is missing dependencies. Fix it as follows:

```bash
# Enter project root
cd your-project-directory
source .venv/bin/activate
python -m pip install -r requirements.txt
python -c "import mlx_whisper, senko; print('ok')"
```

If you don't have `.venv`, create it first:
```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

#### Q2: pip download is slow or fails
You can temporarily use a mirror:
```bash
python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
```

#### Q3: `Could not find a version that satisfies the requirement senko`
`senko` is not on PyPI and needs to be installed from GitHub. `requirements.txt` is already configured for this.
If it still fails, please ensure you can access GitHub and have command-line tools installed, then retry:
```bash
xcode-select --install
python -m pip install -r requirements.txt
```

#### Q4: Error `ffmpeg` not found
```bash
brew install ffmpeg
```

#### Q5: Slow first transcription
The first run downloads models or initializes caches; subsequent runs will be significantly faster.

### 6. Project Structure

```text
.
├── data/
│   ├── uploads/            # Temporary uploads (runtime)
│   └── transcriptions/     # Transcription results (runtime)
├── public/                 # Frontend static pages
│   ├── css/
│   ├── js/
│   └── index.html
├── scripts/
│   └── transcribe_senko.py # MLX + Senko core script
├── docs/
│   └── DEPLOYMENT.md       # Deployment instructions
├── server.js               # Node API + SSE + Result saving
├── requirements.txt        # Python dependencies
├── package.json            # Node dependencies & start scripts
└── .env.example            # Environment variables template
```

### 7. API Summary

- `POST /api/transcribe`: Upload audio and start task
- `GET /api/progress/:clientId`: SSE progress stream
- `POST /api/stop/:clientId`: Stop and save partial results
- `GET /api/health`: Health check

For detailed deployment instructions, see: `docs/DEPLOYMENT.md`

---

<a id="中文"></a>

## 中文说明

一个可直接部署的网页音频转录工具，支持：
- 拖拽上传音频
- 实时进度（SSE）
- 说话人分离（Senko）
- 按 speaker 轮次拼合输出（减少碎片化）
- 导出 `JSON / TXT / Markdown`

### 1. 系统要求

推荐环境（当前默认路径）：
- macOS (Apple Silicon, M1/M2/M3)
- Node.js 18+
- Python 3.10+（推荐 3.12）
- FFmpeg

安装 FFmpeg：
```bash
brew install ffmpeg
```

### 2. 安装与启动（按顺序执行）

在项目根目录执行：

```bash
# 进入项目根目录
cd your-project-directory

# 1) Node 依赖
npm install

# 2) Python 虚拟环境（推荐 3.12）
python3.12 -m venv .venv
source .venv/bin/activate

# 3) Python 依赖
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

# 4) 验证关键依赖
python -c "import mlx_whisper, senko; print('python deps ok')"

# 5) 启动
npm run dev
# 或 npm start
```

浏览器访问：`http://localhost:3000`

### 3. 使用说明

1. 打开页面后上传音频文件（mp3/wav/m4a/webm/ogg/flac）。
2. 选择语言、模型、输出格式，按需勾选说话人分离。
3. 点击“开始转录”，等待进度完成。
4. 结果页支持复制、下载，并显示 speaker 拼合后的段落。

转录文件默认保存在：
- `data/transcriptions/`

上传临时文件目录：
- `data/uploads/`

### 4. 环境变量（可选）

`server.js` 默认会优先使用项目内 `.venv/bin/python`，一般不需要额外配置。

如需自定义，可设置：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务端口 |
| `PYTHON_EXECUTABLE` | 自动优先 `.venv/bin/python` | Python 解释器路径 |
| `TRANSCRIBE_SCRIPT` | `./scripts/transcribe_senko.py` | 转录脚本路径 |
| `DATA_DIR` | `./data` | 运行时数据目录 |
| `HF_HOME` | `./.cache/huggingface` | 模型缓存目录 |
| `MERGE_MAX_GAP_SECONDS` | `15` | 同 speaker 拼合允许的最大时间间隔（秒） |
| `MERGE_MAX_CHARS` | `1200` | 单段拼合后的最大字符数 |

如果你使用 `.env`：
```bash
cp .env.example .env
set -a && source .env && set +a
```

### 5. 常见问题

#### Q1: 启动后报 `No module named 'mlx_whisper'`
说明服务使用的 Python 环境没有安装依赖。按下面修复：

```bash
# 进入项目根目录
cd your-project-directory
source .venv/bin/activate
python -m pip install -r requirements.txt
python -c "import mlx_whisper, senko; print('ok')"
```

如果你没有 `.venv`，先创建：
```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

#### Q2: pip 下载慢或失败
可临时使用镜像：
```bash
python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
```

#### Q3: `Could not find a version that satisfies the requirement senko`
`senko` 不在 PyPI，需要从 GitHub 安装。仓库里已配置好 `requirements.txt`。  
如果仍失败，请先确认可访问 GitHub 并安装命令行工具后重试：
```bash
xcode-select --install
python -m pip install -r requirements.txt
```

#### Q4: 报错找不到 `ffmpeg`
```bash
brew install ffmpeg
```

#### Q5: 首次转录慢
首次会下载模型或初始化缓存，后续会明显加速。

### 6. 项目结构

```text
.
├── data/
│   ├── uploads/            # 上传临时文件（运行时）
│   └── transcriptions/     # 转录结果（运行时）
├── public/                 # 前端静态页面
│   ├── css/
│   ├── js/
│   └── index.html
├── scripts/
│   └── transcribe_senko.py # MLX + Senko 核心脚本
├── docs/
│   └── DEPLOYMENT.md       # 部署说明
├── server.js               # Node API + SSE + 结果保存
├── requirements.txt        # Python 依赖
├── package.json            # Node 依赖与启动脚本
└── .env.example            # 环境变量模板
```

### 7. API 简述

- `POST /api/transcribe`: Upload audio and start task
- `GET /api/progress/:clientId`: SSE progress stream
- `POST /api/stop/:clientId`: Stop and save partial results
- `GET /api/health`: Health check

详细部署说明见：`docs/DEPLOYMENT.md`

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_ROOT = __dirname;
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const resolveFromRoot = (value, fallback) => {
  const target = value || fallback;
  return path.isAbsolute(target) ? target : path.resolve(APP_ROOT, target);
};

const DATA_DIR = resolveFromRoot(process.env.DATA_DIR, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const TRANSCRIPTIONS_DIR = path.join(DATA_DIR, 'transcriptions');
const HF_HOME = resolveFromRoot(process.env.HF_HOME, '.cache/huggingface');
const VENV_PYTHON = path.join(APP_ROOT, '.venv', 'bin', 'python');
const PYTHON_EXECUTABLE = process.env.PYTHON_EXECUTABLE || process.env.PYTHON ||
  (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');
const TRANSCRIBE_SCRIPT = resolveFromRoot(
  process.env.TRANSCRIBE_SCRIPT,
  'scripts/transcribe_senko.py'
);
const MERGE_MAX_GAP_SECONDS = Number(process.env.MERGE_MAX_GAP_SECONDS || 15);
const MERGE_MAX_CHARS = Number(process.env.MERGE_MAX_CHARS || 1200);

for (const dir of [DATA_DIR, UPLOADS_DIR, TRANSCRIPTIONS_DIR, HF_HOME]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (!fs.existsSync(TRANSCRIBE_SCRIPT)) {
  console.error(`❌ Transcription script not found: ${TRANSCRIBE_SCRIPT}`);
  process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `audio_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/webm'];
    if (allowedMimes.includes(file.mimetype) || file.originalname.match(/\.(wav|mp3|m4a|webm|ogg|flac)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported audio format'));
    }
  },
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
});

// Store active SSE clients and python processes
const sseClients = new Map();
const pythonProcessMap = new Map();

// API: Transcribe audio with SSE progress
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file received' });
    }

    const { language, enableDiarization = 'true', outputFormat = 'json', modelSize = 'large-v3' } = req.body;
    const audioFilePath = req.file.path;
    const clientId = req.headers['x-client-id'] || Date.now().toString();

    console.log(`📁 Transcribing: ${audioFilePath}`);
    console.log(`   Language: ${language || 'auto'}, Diarization: ${enableDiarization}, Format: ${outputFormat}`);

    // Return success immediately with taskId (clientId)
    res.status(202).json({
      success: true,
      message: 'Task started',
      taskId: clientId
    });

    // Start processing in background (await but don't hold the response)
    processAudioInBackground(
      audioFilePath,
      language,
      enableDiarization,
      outputFormat,
      modelSize,
      clientId
    );

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    // Only send error if we haven't sent response yet
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Background processing function
async function processAudioInBackground(audioFilePath, language, enableDiarization, outputFormat, modelSize, clientId) {
  try {
    const result = await runTranscriptionWithProgress(
      audioFilePath,
      language,
      enableDiarization === 'true',
      outputFormat,
      modelSize,
      clientId
    );

    // Clean up uploaded file
    try { fs.unlinkSync(audioFilePath); } catch (e) { }

    if (result && result.success !== false) {
      // Save transcription
      const savedFile = await saveTranscription(result, outputFormat);
      result.savedFile = savedFile;

      // Send final result via SSE
      // Note: runTranscriptionWithProgress already sends 'complete' or 'partial' event
      // We just log here for server side tracking
      console.log(`✅ Task ${clientId} completed`);
    } else {
      // Error handled by runTranscriptionWithProgress sending SSE error
      console.error(`❌ Task ${clientId} failed: ${result.error}`);
    }

  } catch (error) {
    console.error(`❌ Background task error:`, error);
    sendProgress(clientId, { type: 'error', message: '服务器内部错误' });
  }
}

// SSE endpoint for progress updates
app.get('/api/progress/:clientId', (req, res) => {
  const clientId = req.params.clientId;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

  // Store client connection
  sseClients.set(clientId, res);

  // Handle client disconnect
  req.on('close', () => {
    sseClients.delete(clientId);
    console.log(`SSE client ${clientId} disconnected`);
  });
});

// API: Stop transcription
app.post('/api/stop/:clientId', (req, res) => {
  const clientId = req.params.clientId;
  const process = pythonProcessMap.get(clientId);

  if (process) {
    console.log(`🛑 Stopping transcription for client ${clientId}`);
    process.kill('SIGINT'); // Send SIGINT to allow graceful shutdown and saving
    res.json({ success: true, message: 'Stopping transcription...' });
  } else {
    res.status(404).json({ error: 'Process not found' });
  }
});

// Send progress to SSE client
function sendProgress(clientId, data) {
  const client = sseClients.get(clientId);
  if (client) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function isLikelyResultPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  if (payload.type === 'progress' || payload.stage) {
    return false;
  }

  return (
    Object.prototype.hasOwnProperty.call(payload, 'success') ||
    Object.prototype.hasOwnProperty.call(payload, 'segments') ||
    Object.prototype.hasOwnProperty.call(payload, 'transcription') ||
    Object.prototype.hasOwnProperty.call(payload, 'metadata') ||
    payload.type === 'error'
  );
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseResultFromStdout(stdoutRaw) {
  if (!stdoutRaw || !stdoutRaw.trim()) {
    return null;
  }

  const marker = 'RESULT:';
  const markerIndex = stdoutRaw.lastIndexOf(marker);

  if (markerIndex >= 0) {
    const candidate = stdoutRaw.slice(markerIndex + marker.length).trim();
    const direct = parseJsonSafe(candidate);
    if (isLikelyResultPayload(direct)) {
      return direct;
    }

    const extracted = extractFirstJsonObject(candidate);
    if (extracted) {
      const parsed = parseJsonSafe(extracted);
      if (isLikelyResultPayload(parsed)) {
        return parsed;
      }
    }
  }

  const direct = parseJsonSafe(stdoutRaw.trim());
  if (isLikelyResultPayload(direct)) {
    return direct;
  }

  const extracted = extractFirstJsonObject(stdoutRaw);
  if (!extracted) {
    return null;
  }

  const parsed = parseJsonSafe(extracted);
  return isLikelyResultPayload(parsed) ? parsed : null;
}

function formatSpeakerDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(seconds || 0));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function isCjkChar(char) {
  return /[\u3400-\u9FFF]/.test(char || '');
}

function joinSegmentText(prevText, nextText) {
  const left = (prevText || '').trim();
  const right = (nextText || '').trim();

  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const leftTail = left[left.length - 1];
  const rightHead = right[0];

  if (/\s/.test(leftTail) || /^[,.;:!?，。；：！？、]/.test(rightHead)) {
    return left + right;
  }

  if (isCjkChar(leftTail) && isCjkChar(rightHead)) {
    return left + right;
  }

  return `${left} ${right}`;
}

function mergeSegmentsBySpeakerTurns(rawSegments, options = {}) {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return [];
  }

  const maxGapSeconds = Number(options.maxGapSeconds ?? MERGE_MAX_GAP_SECONDS);
  const maxMergedChars = Number(options.maxMergedChars ?? MERGE_MAX_CHARS);

  const normalized = rawSegments
    .map((seg) => ({
      ...seg,
      start: Number(seg.start) || 0,
      end: Number(seg.end) || 0,
      text: (seg.text || '').trim(),
      speaker: seg.speaker || 'Unknown'
    }))
    .filter((seg) => seg.text.length > 0)
    .sort((a, b) => a.start - b.start);

  if (!normalized.length) {
    return [];
  }

  const merged = [];
  let current = { ...normalized[0] };

  for (let i = 1; i < normalized.length; i++) {
    const next = normalized[i];
    const gap = Math.max(0, next.start - current.end);
    const sameSpeaker = next.speaker === current.speaker;
    const nextTextLength = (current.text.length + next.text.length);
    const canMerge = sameSpeaker && gap <= maxGapSeconds && nextTextLength <= maxMergedChars;

    if (canMerge) {
      current.end = Math.max(current.end, next.end);
      current.text = joinSegmentText(current.text, next.text);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }

  merged.push(current);
  return merged;
}

function buildSpeakerStatsFromSegments(segments) {
  const stats = new Map();
  for (const seg of segments) {
    const speaker = seg && seg.speaker;
    if (!speaker) {
      continue;
    }

    const start = Number(seg.start) || 0;
    const end = Number(seg.end) || 0;
    const duration = Math.max(0, end - start);
    const existing = stats.get(speaker) || { id: speaker, segment_count: 0, duration: 0 };
    existing.segment_count += 1;
    existing.duration += duration;
    stats.set(speaker, existing);
  }

  return stats;
}

function normalizeTranscriptionResult(rawResult, context = {}) {
  if (!rawResult || typeof rawResult !== 'object') {
    return null;
  }

  if (rawResult.type === 'progress') {
    return null;
  }

  if (rawResult.type === 'error' && !Object.prototype.hasOwnProperty.call(rawResult, 'success')) {
    return { success: false, error: rawResult.message || 'Transcription failed' };
  }

  const metadata = rawResult.metadata && typeof rawResult.metadata === 'object' ? rawResult.metadata : {};
  const rawSegments = Array.isArray(rawResult.segments) ? rawResult.segments : [];
  const segments = mergeSegmentsBySpeakerTurns(rawSegments);
  const segmentSpeakerStats = buildSpeakerStatsFromSegments(segments);

  let speakers = [];
  if (Array.isArray(rawResult.speakers)) {
    speakers = rawResult.speakers.map((speaker) => ({
      ...speaker,
      id: speaker.id || speaker.name || 'Unknown',
      segment_count: Number(speaker.segment_count) || 0,
      total_time: speaker.total_time || formatSpeakerDuration(
        segmentSpeakerStats.get(speaker.id || speaker.name || '')?.duration || 0
      )
    }));
  } else if (rawResult.speakers && typeof rawResult.speakers === 'object') {
    speakers = Object.entries(rawResult.speakers).map(([id, count]) => {
      const stats = segmentSpeakerStats.get(id);
      return {
        id,
        segment_count: Number(count) || stats?.segment_count || 0,
        total_time: formatSpeakerDuration(stats?.duration || 0)
      };
    });
  }

  if (!speakers.length && segmentSpeakerStats.size > 0) {
    speakers = Array.from(segmentSpeakerStats.values()).map((item) => ({
      id: item.id,
      segment_count: item.segment_count,
      total_time: formatSpeakerDuration(item.duration)
    }));
  }

  const normalized = {
    ...rawResult,
    success: rawResult.success !== false,
    file: rawResult.file || metadata.audio_file || context.file || 'audio',
    model: rawResult.model || metadata.model || context.modelSize || 'distil-large-v3',
    device: rawResult.device || metadata.device || 'Apple Silicon (MLX)',
    language: rawResult.language || metadata.language || context.language || 'auto',
    duration: Number(rawResult.duration) || Number(metadata.duration) || 0,
    segments,
    raw_segment_count: rawSegments.length,
    merged_segment_count: segments.length,
    speakers,
    has_diarization: typeof rawResult.has_diarization === 'boolean'
      ? rawResult.has_diarization
      : context.enableDiarization !== false,
    transcription: rawResult.transcription || segments.map((seg) => seg.text || '').join(' ').trim(),
    is_partial: Boolean(rawResult.is_partial)
  };

  if (rawResult.formatted_output) {
    normalized.formatted_output = rawResult.formatted_output;
  } else if (rawResult.formatted_text) {
    normalized.formatted_output = rawResult.formatted_text;
  }

  return normalized;
}

// Run Python transcription with streaming progress
async function runTranscriptionWithProgress(audioPath, language, enableDiarization, outputFormat, modelSize, clientId) {
  return new Promise((resolve, reject) => {
    const args = [
      TRANSCRIBE_SCRIPT,
      audioPath,
      '--model', modelSize,
      '--format', outputFormat,
      '--stream',  // Enable streaming progress
      '--quiet'
    ];

    if (language) {
      args.push('--language', language);
    }
    if (!enableDiarization) {
      args.push('--no-diarization');
    }

    console.log(`🔧 Running: ${PYTHON_EXECUTABLE} ${args.join(' ')}`);

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      HF_HOME
    };

    const pythonProcess = spawn(PYTHON_EXECUTABLE, args, { env });

    // Store process reference
    pythonProcessMap.set(clientId, pythonProcess);

    let stdoutRaw = '';
    let stdoutLineBuffer = '';
    let stderr = '';
    let result = null;

    // No timeout - let it run as long as needed
    // For very long audio, large-v3 model can take hours
    console.log(`⏳ Processing with ${modelSize} model (no timeout)...`);

    pythonProcess.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdoutRaw += chunk;
      stdoutLineBuffer += chunk;

      let newlineIndex = stdoutLineBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = stdoutLineBuffer.slice(0, newlineIndex).trim();
        stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);

        if (!line) {
          newlineIndex = stdoutLineBuffer.indexOf('\n');
          continue;
        }

        if (line.startsWith('PROGRESS:')) {
          // Parse and forward progress to SSE client
          try {
            const progressData = JSON.parse(line.substring(9));
            console.log(`📊 Progress: ${progressData.percent}% - ${progressData.message}`);
            sendProgress(clientId, progressData);
          } catch (e) {
            console.log('Progress parse error:', line);
          }
        }

        newlineIndex = stdoutLineBuffer.indexOf('\n');
      }
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log('📝', data.toString().trim());
    });

    pythonProcess.on('close', (code) => {
      // Remove process reference
      pythonProcessMap.delete(clientId);

      const parsed = parseResultFromStdout(stdoutRaw);
      result = normalizeTranscriptionResult(parsed, {
        language,
        enableDiarization,
        modelSize,
        file: path.basename(audioPath)
      });

      if (result) {
        if (result.success === false) {
          console.error('❌ Transcription failed with result:', result.error);
          sendProgress(clientId, { type: 'error', message: result.error || '转录失败' });
          resolve(result); // Pass error result up
          return;
        }

        const isPartial = result.is_partial;
        console.log(isPartial ? '⚠️ Transcription interrupted (partial saved)' : '✅ Transcription complete');

        sendProgress(clientId, {
          type: isPartial ? 'partial' : 'complete',
          percent: 100,
          message: isPartial ? '已停止并保存进度' : '处理完成！',
          result: result
        });
        resolve(result);
      } else if (code === 0) {
        console.error('Parse error:', stdoutRaw.slice(-1000));
        resolve({ success: false, error: 'Failed to parse transcription result' });
      } else {
        console.error('Process error:', stderr);
        sendProgress(clientId, { type: 'error', message: '转录失败' });
        resolve({ success: false, error: stderr || 'Transcription failed' });
      }
    });

    pythonProcess.on('error', (error) => {
      sendProgress(clientId, { type: 'error', message: error.message });
      resolve({ success: false, error: error.message });
    });
  });
}

// Save transcription to file
async function saveTranscription(result, format) {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const ext = format === 'markdown' ? 'md' : format === 'txt' ? 'txt' : 'json';
  const filename = `transcription_${timestamp}.${ext}`;
  const filePath = path.join(TRANSCRIPTIONS_DIR, filename);

  let content;
  if (format === 'txt') {
    content = formatAsTxt(result);
  } else if (format === 'markdown') {
    content = formatAsMarkdown(result);
  } else if (result.formatted_output) {
    content = result.formatted_output;
  } else if (result.formatted_text) {
    content = result.formatted_text;
  } else {
    content = JSON.stringify(result, null, 2);
  }

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`💾 Saved: ${filename}`);

  return { filename, path: filePath };
}

// Format as plain text
function formatAsTxt(result) {
  const lines = [];
  lines.push('='.repeat(60));
  lines.push('Audio Transcription Result');
  lines.push('='.repeat(60));
  lines.push(`File: ${result.file}`);
  lines.push(`Language: ${result.language}`);
  lines.push(`Duration: ${result.duration}s`);
  lines.push(`Speakers: ${result.speakers?.length || 0}`);
  lines.push('');

  if (result.speakers && result.speakers.length > 0) {
    lines.push('Speaker Summary:');
    result.speakers.forEach(s => {
      lines.push(`  - ${s.id}: ${s.total_time} (${s.segment_count} segments)`);
    });
    lines.push('');
  }

  lines.push('Transcription:');
  lines.push('-'.repeat(40));
  result.segments?.forEach(seg => {
    const speaker = seg.speaker || 'Unknown';
    const time = formatTime(seg.start);
    lines.push(`[${time}] ${speaker}: ${seg.text}`);
  });

  return lines.join('\n');
}

// Format as Markdown
function formatAsMarkdown(result) {
  const lines = [];
  lines.push('# Audio Transcription');
  lines.push('');
  lines.push(`**File:** ${result.file}`);
  lines.push(`**Language:** ${result.language}`);
  lines.push(`**Duration:** ${result.duration}s`);
  lines.push('');

  if (result.speakers && result.speakers.length > 0) {
    lines.push('## Speakers');
    lines.push('');
    lines.push('| Speaker | Duration | Segments |');
    lines.push('|---------|----------|----------|');
    result.speakers.forEach(s => {
      lines.push(`| ${s.id} | ${s.total_time} | ${s.segment_count} |`);
    });
    lines.push('');
  }

  lines.push('## Transcription');
  lines.push('');

  let currentSpeaker = null;
  result.segments?.forEach(seg => {
    const speaker = seg.speaker || 'Unknown';
    if (speaker !== currentSpeaker) {
      if (currentSpeaker) lines.push('');
      lines.push(`### ${speaker}`);
      lines.push('');
      currentSpeaker = speaker;
    }
    lines.push(`**[${formatTime(seg.start)}]** ${seg.text}`);
  });

  return lines.join('\n');
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// API: Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    script: path.basename(TRANSCRIBE_SCRIPT),
    python: PYTHON_EXECUTABLE
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Error handler
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large (max 500MB)' });
  }
  console.error('Server error:', error);
  res.status(500).json({ error: 'Server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Audio Transcription Server running at http://localhost:${PORT}`);
    console.log(`📍 Using Python: ${PYTHON_EXECUTABLE}`);
    console.log(`📄 Script: ${TRANSCRIBE_SCRIPT}`);
    console.log(`💾 Data dir: ${DATA_DIR}`);
    console.log(`⏱️ No timeout limit - runs until complete`);
  });
}

module.exports = app;

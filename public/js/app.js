/**
 * Audio Transcription App - Frontend Logic with Real-Time Progress
 */

// State
let selectedFile = null;
let currentResult = null;
let eventSource = null;
let clientId = Date.now().toString();
let timerInterval = null;
let timerStartTime = null;

// DOM Elements
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const removeFile = document.getElementById('removeFile');
const transcribeBtn = document.getElementById('transcribeBtn');
const languageSelect = document.getElementById('language');
const modelSizeSelect = document.getElementById('modelSize');
const outputFormatSelect = document.getElementById('outputFormat');
const enableDiarization = document.getElementById('enableDiarization');
const progressSection = document.getElementById('progressSection');
const progressText = document.getElementById('progressText');
const progressFill = document.getElementById('progressFill');
const resultsSection = document.getElementById('resultsSection');
const resultsMeta = document.getElementById('resultsMeta');
const speakersSummary = document.getElementById('speakersSummary');
const speakersList = document.getElementById('speakersList');
const transcriptionOutput = document.getElementById('transcriptionOutput');
const errorSection = document.getElementById('errorSection');
const errorMessage = document.getElementById('errorMessage');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const retryBtn = document.getElementById('retryBtn');
const stopBtn = document.getElementById('stopBtn');
const timerDisplay = document.getElementById('timerDisplay');

// Speaker colors
const speakerColors = ['#6366f1', '#22d3ee', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6'];

// Event Listeners
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', handleDragOver);
dropzone.addEventListener('dragleave', handleDragLeave);
dropzone.addEventListener('drop', handleDrop);
fileInput.addEventListener('change', handleFileSelect);
removeFile.addEventListener('click', clearFile);
transcribeBtn.addEventListener('click', startTranscription);
copyBtn.addEventListener('click', copyTranscription);
downloadBtn.addEventListener('click', downloadTranscription);
retryBtn.addEventListener('click', resetUI);
stopBtn.addEventListener('click', stopTranscription);

// Timer Functions
function formatTimerTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function startTimer() {
    timerStartTime = Date.now();
    if (timerDisplay) timerDisplay.textContent = '00:00';
    timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - timerStartTime) / 1000);
        if (timerDisplay) timerDisplay.textContent = formatTimerTime(elapsed);
    }, 1000);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    // Return elapsed time in seconds
    if (timerStartTime) {
        return Math.floor((Date.now() - timerStartTime) / 1000);
    }
    return 0;
}

// Drag & Drop Handlers
function handleDragOver(e) {
    e.preventDefault();
    dropzone.classList.add('dragover');
}

function handleDragLeave(e) {
    e.preventDefault();
    dropzone.classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        selectFile(files[0]);
    }
}

function handleFileSelect(e) {
    if (e.target.files.length > 0) {
        selectFile(e.target.files[0]);
    }
}

function selectFile(file) {
    // Validate file type
    const validTypes = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/webm', 'audio/ogg', 'audio/flac'];
    const validExtensions = ['.mp3', '.wav', '.m4a', '.webm', '.ogg', '.flac'];

    const isValidType = validTypes.some(type => file.type.includes(type.split('/')[1]));
    const isValidExt = validExtensions.some(ext => file.name.toLowerCase().endsWith(ext));

    if (!isValidType && !isValidExt) {
        showError('请选择有效的音频文件 (MP3, WAV, M4A, WebM, OGG, FLAC)');
        return;
    }

    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);

    dropzone.classList.add('hidden');
    fileInfo.classList.remove('hidden');
    transcribeBtn.disabled = false;
}

function clearFile() {
    selectedFile = null;
    fileInput.value = '';
    fileInfo.classList.add('hidden');
    dropzone.classList.remove('hidden');
    transcribeBtn.disabled = true;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// SSE Progress Connection
function connectToProgress() {
    clientId = Date.now().toString();

    if (eventSource) {
        eventSource.close();
    }

    eventSource = new EventSource(`/api/progress/${clientId}`);

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'connected') {
                console.log('SSE connected:', data.clientId);
            } else if (data.type === 'progress') {
                updateProgress(data.percent, data.message);
            } else if (data.type === 'complete') {
                updateProgress(100, data.message);

                // Final result received via SSE
                if (data.result) {
                    currentResult = data.result;
                    displayResults(data.result);
                    // Close SSE after completion
                    if (eventSource) {
                        eventSource.close();
                        eventSource = null;
                    }
                }
            } else if (data.type === 'partial') {
                updateProgress(100, data.message);
                // Partial result is sent in data.result
                if (data.result) {
                    currentResult = data.result;
                    displayResults(data.result);
                    // Close SSE after partial completion
                    if (eventSource) {
                        eventSource.close();
                        eventSource = null;
                    }
                }
            } else if (data.type === 'error') {
                console.error('SSE error:', data.message);
                showError(data.message);
                if (eventSource) {
                    eventSource.close();
                    eventSource = null;
                }
            }
        } catch (e) {
            console.log('SSE parse error:', event.data);
        }
    };

    eventSource.onerror = (error) => {
        console.log('SSE connection error, will retry...');
    };

    return clientId;
}

function updateProgress(percent, message) {
    if (progressFill) {
        progressFill.style.width = `${percent}%`;
        progressFill.style.animation = 'none';  // Stop pulse animation when real progress
    }
    if (progressText) {
        progressText.textContent = message;
    }
    console.log(`Progress: ${percent}% - ${message}`);
}

// Transcription
async function startTranscription() {
    if (!selectedFile) return;

    // Connect to SSE for progress updates
    const currentClientId = connectToProgress();

    // Show progress
    hideAllSections();
    progressSection.classList.remove('hidden');
    stopBtn.classList.remove('hidden'); // Show stop button
    startTimer(); // Start the timer
    updateProgress(0, '正在上传文件...');

    const formData = new FormData();
    formData.append('audio', selectedFile);
    formData.append('language', languageSelect.value);
    formData.append('modelSize', modelSizeSelect.value);
    formData.append('enableDiarization', enableDiarization.checked ? 'true' : 'false');
    formData.append('outputFormat', outputFormatSelect.value);

    try {
        updateProgress(2, '文件已上传，正在处理...');

        const response = await fetch('/api/transcribe', {
            method: 'POST',
            body: formData,
            headers: {
                'X-Client-ID': currentClientId
            }
        });

        const result = await response.json();

        if (response.ok && result.success) {
            console.log('Task started:', result.message);
            // Async flow: We wait for SSE 'complete' event to handle results.
            // Do NOT close SSE here.
        } else {
            throw new Error(result.error || '转录失败');
        }
    } catch (error) {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
        showError(error.message);
    }
}


async function stopTranscription() {
    if (!clientId) return;

    stopBtn.disabled = true;
    stopBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在停止...';

    try {
        const response = await fetch(`/api/stop/${clientId}`, { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            updateProgress(null, '正在保存进度...');
        }
    } catch (e) {
        console.error('Stop error:', e);
    }
}

function hideAllSections() {
    progressSection.classList.add('hidden');
    resultsSection.classList.add('hidden');
    errorSection.classList.add('hidden');
}

function displayResults(result) {
    // Stop timer and get elapsed time
    const elapsedSeconds = stopTimer();
    const elapsedFormatted = formatTimerTime(elapsedSeconds);
    const mergedSegments = result.segments?.length || 0;
    const rawSegments = result.raw_segment_count || mergedSegments;
    const segmentLabel = rawSegments === mergedSegments
        ? `${mergedSegments}`
        : `${mergedSegments} (原始 ${rawSegments})`;

    hideAllSections();
    resultsSection.classList.remove('hidden');

    // Update header for partial results
    const resultsHeader = document.querySelector('.results-header h2');
    if (result.is_partial) {
        resultsHeader.innerHTML = '<i class="fas fa-pause-circle" style="color: var(--warning)"></i> 转录已停止 (部分保存)';
    } else {
        resultsHeader.innerHTML = '<i class="fas fa-check-circle"></i> 转录完成';
    }

    // Meta info
    resultsMeta.innerHTML = `
    <div class="meta-item">
      <i class="fas fa-language"></i>
      <span class="meta-label">语言:</span>
      <span class="meta-value">${result.language || '自动检测'}</span>
    </div>
    <div class="meta-item">
      <i class="fas fa-clock"></i>
      <span class="meta-label">时长:</span>
      <span class="meta-value">${formatDuration(result.duration)}</span>
    </div>
    <div class="meta-item">
      <i class="fas fa-stopwatch"></i>
      <span class="meta-label">耗时:</span>
      <span class="meta-value" style="color: var(--primary); font-weight: 600;">${elapsedFormatted}</span>
    </div>
    <div class="meta-item">
      <i class="fas fa-microchip"></i>
      <span class="meta-label">设备:</span>
      <span class="meta-value">${result.device || 'CPU'}</span>
    </div>
    <div class="meta-item">
      <i class="fas fa-list"></i>
      <span class="meta-label">段落:</span>
      <span class="meta-value">${segmentLabel}</span>
    </div>
  `;

    // Speakers
    if (result.speakers && result.speakers.length > 0) {
        speakersSummary.classList.remove('hidden');
        speakersList.innerHTML = result.speakers.map((speaker, idx) => {
            const color = speakerColors[idx % speakerColors.length];
            return `
        <div class="speaker-tag">
          <span class="speaker-dot" style="background: ${color}"></span>
          <span>${speaker.id}</span>
          <span style="color: var(--text-muted)">${speaker.total_time}</span>
        </div>
      `;
        }).join('');
    } else {
        speakersSummary.classList.add('hidden');
    }

    // Transcription segments
    if (result.segments && result.segments.length > 0) {
        const speakerColorMap = {};
        result.speakers?.forEach((s, idx) => {
            speakerColorMap[s.id] = speakerColors[idx % speakerColors.length];
        });

        transcriptionOutput.innerHTML = result.segments.map(seg => {
            const speaker = seg.speaker || 'Unknown';
            const color = speakerColorMap[speaker] || '#6366f1';
            const time = formatTime(seg.start);
            return `
        <div class="segment">
          <div class="segment-header">
            <span class="segment-speaker" style="color: ${color}">${speaker}</span>
            <span class="segment-time">[${time}]</span>
          </div>
          <div class="segment-text">${escapeHtml(seg.text)}</div>
        </div>
      `;
        }).join('');
    } else if (result.transcription) {
        transcriptionOutput.innerHTML = `<p>${escapeHtml(result.transcription)}</p>`;
    }
}

function showError(message) {
    stopTimer(); // Stop timer on error
    hideAllSections();
    errorSection.classList.remove('hidden');
    errorMessage.textContent = message;
}

function resetUI() {
    hideAllSections();
    clearFile();
    // Reset progress bar
    if (progressFill) {
        progressFill.style.width = '30%';
        progressFill.style.animation = 'progress-pulse 1.5s ease-in-out infinite';
    }

    // Reset stop button
    stopBtn.classList.add('hidden');
    stopBtn.disabled = false;
    stopBtn.innerHTML = '<i class="fas fa-stop-circle"></i> 停止并保存';
}

// Utility functions
function formatDuration(seconds) {
    if (!seconds) return '未知';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}分${secs}秒`;
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Copy & Download
function copyTranscription() {
    if (!currentResult) return;

    let text = '';
    if (currentResult.segments) {
        text = currentResult.segments.map(seg => {
            const speaker = seg.speaker || 'Unknown';
            const time = formatTime(seg.start);
            return `[${time}] ${speaker}: ${seg.text}`;
        }).join('\n');
    } else {
        text = currentResult.transcription || '';
    }

    navigator.clipboard.writeText(text).then(() => {
        const originalText = copyBtn.innerHTML;
        copyBtn.innerHTML = '<i class="fas fa-check"></i> 已复制';
        setTimeout(() => {
            copyBtn.innerHTML = originalText;
        }, 2000);
    });
}

function downloadTranscription() {
    if (!currentResult) return;

    const format = outputFormatSelect.value;
    let content, filename, mimeType;

    if (format === 'markdown') {
        content = generateMarkdown(currentResult);
        filename = 'transcription.md';
        mimeType = 'text/markdown';
    } else if (format === 'txt') {
        content = generateTxt(currentResult);
        filename = 'transcription.txt';
        mimeType = 'text/plain';
    } else {
        content = JSON.stringify(currentResult, null, 2);
        filename = 'transcription.json';
        mimeType = 'application/json';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function generateTxt(result) {
    const lines = [];
    lines.push('='.repeat(60));
    lines.push('Audio Transcription Result');
    lines.push('='.repeat(60));
    lines.push(`Language: ${result.language || 'auto'}`);
    lines.push(`Duration: ${result.duration}s`);
    lines.push('');

    if (result.speakers?.length > 0) {
        lines.push('Speakers:');
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

function generateMarkdown(result) {
    const lines = [];
    lines.push('# Audio Transcription');
    lines.push('');
    lines.push(`**Language:** ${result.language || 'auto'}`);
    lines.push(`**Duration:** ${result.duration}s`);
    lines.push('');

    if (result.speakers?.length > 0) {
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

// Init
console.log('🎙️ Audio Transcription App loaded with SSE progress support');

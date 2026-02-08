#!/usr/bin/env python3
"""Audio transcription with mlx-whisper + senko diarization.

Optimized for Apple Silicon:
- MLX acceleration for transcription
- Senko CoreML for speaker diarization
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple


@dataclass
class TranscriptionConfig:
    audio_path: str
    model_size: str = "distil-large-v3"
    language: Optional[str] = None
    enable_diarization: bool = True
    output_format: str = "json"
    output_path: Optional[str] = None
    hf_token: Optional[str] = None
    quiet: bool = False
    stream_progress: bool = False
    senko_warmup: bool = False


def log(message: str, quiet: bool = False) -> None:
    if not quiet:
        print(message, file=sys.stderr, flush=True)


def progress(stage: str, percent: int, message: str) -> None:
    """Output progress in JSON format for streaming."""
    payload = json.dumps(
        {"type": "progress", "stage": stage, "percent": percent, "message": message},
        ensure_ascii=False,
    )
    print(f"PROGRESS:{payload}", flush=True)


current_segments: List[Dict] = []
current_metadata: Dict = {}
interrupted = False


def signal_handler(sig, frame) -> None:
    """Handle interrupt signals to save partial progress."""
    del sig, frame  # unused, required by signal API
    global interrupted
    if not interrupted:
        interrupted = True
        progress("interrupt", 0, "正在停止并保存进度...")
    else:
        sys.exit(1)


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


def safe_unlink(file_path: Optional[str]) -> None:
    if file_path and os.path.exists(file_path):
        try:
            os.unlink(file_path)
        except OSError:
            pass


def convert_to_wav(audio_path: str, stream: bool = False) -> str:
    """Convert audio to 16kHz mono WAV for senko."""
    if stream:
        progress("converting", 5, "正在转换音频格式...")

    temp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    command = [
        "ffmpeg",
        "-i",
        audio_path,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        "-y",
        temp_wav,
    ]
    proc = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        safe_unlink(temp_wav)
        error_line = proc.stderr.strip().splitlines()[-1] if proc.stderr else "ffmpeg failed"
        raise RuntimeError(f"Audio conversion failed: {error_line}")
    return temp_wav


def resolve_model_source(model_size: str) -> str:
    """Prefer local model path to avoid repeated remote resolution."""
    project_root = Path(__file__).resolve().parent.parent
    local_model = project_root / "mlx_models" / model_size
    if local_model.exists():
        return str(local_model)

    model_map = {
        "small": "mlx-community/whisper-small-mlx",
        "medium": "mlx-community/whisper-medium-mlx",
        "distil-large-v3": "mlx-community/distil-whisper-large-v3",
        "large-v3": "mlx-community/whisper-large-v3-mlx",
    }
    return model_map.get(model_size, "mlx-community/whisper-large-v3-mlx")


def run_transcription(
    audio_path: str,
    model_size: str,
    language: Optional[str],
    quiet: bool,
    stream: bool = False,
) -> Tuple[List[Dict], float, str, str]:
    """Run mlx-whisper transcription."""
    global current_segments
    import mlx_whisper

    effective_model = model_size
    if language and language != "en" and model_size == "distil-large-v3":
        effective_model = "large-v3"
        if stream:
            progress("transcription", 12, f"语言为 {language}，切换到多语言模型 large-v3...")
        else:
            log(f"Language is {language}, switching to multilingual model large-v3", quiet)

    if stream:
        progress("transcription", 15, f"正在加载 {effective_model} 模型...")
    else:
        log(f"Loading MLX-Whisper model: {effective_model}", quiet)

    model_source = resolve_model_source(effective_model)
    if stream:
        progress("transcription", 20, "模型加载完成，开始转录...")

    transcribe_start = time.time()
    transcribe_kwargs = {"path_or_hf_repo": model_source, "verbose": (not quiet and not stream)}
    if language:
        transcribe_kwargs["language"] = language

    raw_result = mlx_whisper.transcribe(audio_path, **transcribe_kwargs)
    transcribe_time = time.time() - transcribe_start

    if stream:
        progress("transcription", 60, f"转录完成 ({transcribe_time:.1f}秒)")
    else:
        log(f"Transcription complete in {transcribe_time:.1f}s", quiet)

    detected_language = raw_result.get("language") or language or "auto"
    segments = raw_result.get("segments", [])
    current_segments = []

    for seg in segments:
        if interrupted:
            break
        text = seg.get("text", "").strip()
        if text and text not in ["!", ".", "?", "...", "！", "。", "？"]:
            current_segments.append(
                {
                    "start": round(float(seg.get("start", 0)), 2),
                    "end": round(float(seg.get("end", 0)), 2),
                    "text": text,
                }
            )

    return current_segments, transcribe_time, detected_language, effective_model


def run_senko_diarization(
    wav_path: str, quiet: bool, stream: bool = False, warmup: bool = False
) -> Tuple[List[Dict], float]:
    """Run senko speaker diarization."""
    import senko

    if stream:
        progress("diarization", 65, "正在加载说话人分离模型...")
    else:
        log("Loading Senko diarization model...", quiet)

    diarize_start = time.time()
    diarizer = senko.Diarizer(device="auto", warmup=warmup, quiet=True)

    if stream:
        progress("diarization", 70, "正在进行说话人分离...")

    result = diarizer.diarize(wav_path, generate_colors=False)
    diarize_time = time.time() - diarize_start

    speaker_segments = result.get("merged_segments", [])
    unique_speakers = len(set(seg.get("speaker", "?") for seg in speaker_segments))

    if stream:
        progress("diarization", 85, f"分离完成：{unique_speakers}位说话人 ({diarize_time:.1f}秒)")
    else:
        log(f"Diarization complete: {unique_speakers} speakers in {diarize_time:.1f}s", quiet)

    return speaker_segments, diarize_time


def assign_speakers(segments: List[Dict], speaker_segments: List[Dict]) -> List[Dict]:
    """Assign speakers to transcription segments in linear time."""
    if not speaker_segments:
        return segments

    ordered_speaker_segments = sorted(speaker_segments, key=lambda s: float(s.get("start", 0)))
    speaker_idx = 0

    for seg in segments:
        seg_start = float(seg.get("start", 0))
        seg_end = float(seg.get("end", 0))
        best_speaker = None
        best_overlap = 0.0

        while (
            speaker_idx < len(ordered_speaker_segments)
            and float(ordered_speaker_segments[speaker_idx].get("end", 0)) <= seg_start
        ):
            speaker_idx += 1

        probe_idx = speaker_idx
        while (
            probe_idx < len(ordered_speaker_segments)
            and float(ordered_speaker_segments[probe_idx].get("start", 0)) < seg_end
        ):
            speaker_seg = ordered_speaker_segments[probe_idx]
            speaker_start = float(speaker_seg.get("start", 0))
            speaker_end = float(speaker_seg.get("end", 0))
            overlap = max(0.0, min(seg_end, speaker_end) - max(seg_start, speaker_start))
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = speaker_seg.get("speaker", "SPEAKER_?")
            probe_idx += 1

        if best_speaker:
            seg["speaker"] = best_speaker

    return segments


def format_time(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def build_speaker_summary(segments: List[Dict]) -> List[Dict]:
    summary: Dict[str, Dict[str, float]] = {}

    for seg in segments:
        speaker = seg.get("speaker")
        if not speaker:
            continue

        duration = max(0.0, float(seg.get("end", 0)) - float(seg.get("start", 0)))
        stats = summary.setdefault(speaker, {"duration": 0.0, "segments": 0.0})
        stats["duration"] += duration
        stats["segments"] += 1

    return [
        {
            "id": speaker,
            "segment_count": int(stats["segments"]),
            "total_time": format_time(stats["duration"]),
        }
        for speaker, stats in sorted(summary.items())
    ]


def format_as_txt(segments: List[Dict], speakers: List[Dict], metadata: Dict) -> str:
    lines = []
    lines.append("=" * 60)
    lines.append("Audio Transcription Result")
    lines.append("=" * 60)
    lines.append(f"Language: {metadata.get('language', 'auto')}")
    lines.append(f"Duration: {format_time(metadata.get('duration', 0))}")
    lines.append(f"Speakers: {len(speakers)}")
    lines.append("")

    if speakers:
        lines.append("Speaker Summary:")
        for speaker in speakers:
            lines.append(
                f"  - {speaker['id']}: {speaker['total_time']} "
                f"({speaker['segment_count']} segments)"
            )
        lines.append("")

    lines.append("Transcription:")
    lines.append("-" * 40)
    for seg in segments:
        start = format_time(float(seg.get("start", 0)))
        end = format_time(float(seg.get("end", 0)))
        speaker = seg.get("speaker", "Unknown")
        text = seg.get("text", "")
        lines.append(f"[{speaker}] ({start}-{end}) {text}")

    return "\n".join(lines)


def format_as_markdown(segments: List[Dict], speakers: List[Dict], metadata: Dict) -> str:
    lines = ["# 转录结果", ""]
    lines.append("## 元数据")
    lines.append(f"- **语言**: {metadata.get('language', 'auto')}")
    lines.append(f"- **时长**: {format_time(metadata.get('duration', 0))}")
    lines.append(f"- **说话人**: {len(speakers)} 人")
    lines.append("")

    if speakers:
        lines.append("## 说话人统计")
        for speaker in speakers:
            lines.append(
                f"- **{speaker['id']}**: {speaker['total_time']} "
                f"({speaker['segment_count']} 段)"
            )
        lines.append("")

    lines.append("## 转录内容")
    lines.append("")
    for seg in segments:
        start = format_time(float(seg.get("start", 0)))
        end = format_time(float(seg.get("end", 0)))
        speaker = seg.get("speaker", "Unknown")
        text = seg.get("text", "")
        lines.append(f"**{speaker}** `{start}-{end}`")
        lines.append(f"> {text}")
        lines.append("")

    return "\n".join(lines)


def probe_duration(audio_path: str) -> float:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_format", "-print_format", "json", audio_path],
            capture_output=True,
            text=True,
            check=True,
        )
        probe = json.loads(result.stdout)
        return float(probe["format"].get("duration", 0))
    except Exception:
        return 0.0


def transcribe(config: TranscriptionConfig) -> Dict:
    """Main transcription function."""
    global current_segments, current_metadata

    audio_path = config.audio_path
    quiet = config.quiet
    stream = config.stream_progress

    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    duration = probe_duration(audio_path)
    current_metadata = {
        "audio_file": os.path.basename(audio_path),
        "language": config.language or "auto",
        "duration": duration,
        "model": config.model_size,
    }

    if stream:
        progress("starting", 0, "开始处理音频文件...")

    start_time = time.time()
    wav_path = None

    try:
        wav_future = None
        with ThreadPoolExecutor(max_workers=1) as executor:
            if config.enable_diarization:
                wav_future = executor.submit(convert_to_wav, audio_path, stream)

            segments, transcribe_time, detected_language, effective_model = run_transcription(
                audio_path, config.model_size, config.language, quiet, stream
            )

            if wav_future:
                wav_path = wav_future.result()

        current_metadata["transcription_time"] = transcribe_time
        current_metadata["language"] = detected_language
        current_metadata["model"] = effective_model

        diarize_time = 0.0
        speaker_segments: List[Dict] = []
        if config.enable_diarization and wav_path and not interrupted:
            speaker_segments, diarize_time = run_senko_diarization(
                wav_path, quiet, stream, warmup=config.senko_warmup
            )
            current_metadata["diarization_time"] = diarize_time
            segments = assign_speakers(segments, speaker_segments)
        elif config.enable_diarization and interrupted:
            log("Skipping diarization due to interruption", quiet)

        current_segments = segments
        speakers = build_speaker_summary(segments)
        current_metadata["speakers"] = [speaker["id"] for speaker in speakers]
        current_metadata["total_time"] = time.time() - start_time

        if stream:
            progress("complete", 100, f"处理完成！用时 {current_metadata['total_time']:.1f}秒")

        result = {
            "success": True,
            "file": os.path.basename(audio_path),
            "model": effective_model,
            "device": "Apple Silicon (MLX)",
            "language": detected_language,
            "duration": round(duration, 2),
            "segments": segments,
            "speakers": speakers,
            "has_diarization": bool(config.enable_diarization),
            "transcription": " ".join(seg.get("text", "") for seg in segments).strip(),
            "is_partial": interrupted,
            "metadata": current_metadata,
        }

        if config.output_format == "txt":
            result["formatted_output"] = format_as_txt(segments, speakers, current_metadata)
        elif config.output_format == "markdown":
            result["formatted_output"] = format_as_markdown(segments, speakers, current_metadata)

        if config.output_path:
            with open(config.output_path, "w", encoding="utf-8") as f:
                if config.output_format == "json":
                    f.write(json.dumps(result, ensure_ascii=False, indent=2))
                else:
                    f.write(result.get("formatted_output", ""))

        if stream:
            print("RESULT:" + json.dumps(result, ensure_ascii=False), flush=True)
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))

        return result
    finally:
        safe_unlink(wav_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Audio transcription with MLX-Whisper + Senko")
    parser.add_argument("audio_path", help="Path to audio file")
    parser.add_argument(
        "--model",
        "-m",
        default="distil-large-v3",
        choices=["small", "medium", "distil-large-v3", "large-v3"],
        help="Model size (default: distil-large-v3)",
    )
    parser.add_argument(
        "--language",
        "-l",
        default=None,
        help="Language code (e.g., de, en, zh). Auto-detect if not specified.",
    )
    parser.set_defaults(diarize=True)
    parser.add_argument("--diarize", action="store_true", dest="diarize", help="Enable diarization")
    parser.add_argument(
        "--no-diarize",
        "--no-diarization",
        action="store_false",
        dest="diarize",
        help="Disable speaker diarization",
    )
    parser.add_argument(
        "--format",
        "-f",
        default="json",
        choices=["json", "txt", "markdown"],
        help="Output format (default: json)",
    )
    parser.add_argument("--output", "-o", default=None, help="Output file path")
    parser.add_argument("--quiet", "-q", action="store_true", help="Quiet mode")
    parser.add_argument("--stream", "-s", action="store_true", help="Stream progress for web API")
    parser.add_argument(
        "--senko-warmup",
        action="store_true",
        help="Warm up senko model (recommended only for repeated CLI runs)",
    )

    args = parser.parse_args()

    config = TranscriptionConfig(
        audio_path=args.audio_path,
        model_size=args.model,
        language=args.language,
        enable_diarization=args.diarize,
        output_format=args.format,
        output_path=args.output,
        quiet=args.quiet,
        stream_progress=args.stream,
        senko_warmup=args.senko_warmup,
    )

    try:
        transcribe(config)
    except Exception as exc:
        error_result = {"success": False, "error": str(exc)}
        if config.stream_progress:
            print("RESULT:" + json.dumps(error_result, ensure_ascii=False), flush=True)
        else:
            print(json.dumps(error_result, ensure_ascii=False, indent=2))
        sys.exit(1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
heed transcription + diarization server
Keeps models loaded in memory for instant processing.
Runs as an HTTP server on port 5002.

Endpoints:
  POST /transcribe  {wav_path, language, srt_output}  → {text, srt_path, segments}
  POST /diarize     {wav_path, srt_path, min_speakers, max_speakers} → {speakers, segments, text}
  POST /process     {wav_path, language, diarize, min_speakers, max_speakers} → full result (parallel)
  GET  /health      → {ready, whisper, pyannote}
"""
import json
import os
import sys
import time
import warnings
import threading
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
from concurrent.futures import ThreadPoolExecutor, as_completed

warnings.filterwarnings("ignore")
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

PORT = int(os.environ.get("HEED_TRANSCRIPTION_PORT", "5002"))

# --- Model loading (once, kept in memory) ---
whisper_model = None
diarize_pipeline = None
models_ready = {"whisper": False, "pyannote": False}


# --- Ollama model catalog ---
# Curated list of LLMs we recommend for meeting note generation.
# `vram_mb` is the model footprint when loaded on GPU. We use this to filter
# what's actually safe to run alongside pyannote on the user's hardware.
#
# Sources / sizing:
#   - Llama 3.2: ai.meta.com/blog/llama-3-2 (Sept 2024)
#   - Qwen 2.5:  qwenlm.github.io/blog/qwen2.5 (Sept 2024)
#   - Gemma 3:   blog.google (March 2025)
#   - Gemma 4:   blog.google (April 2026), Apache 2.0, multimodal, 256K ctx
PYANNOTE_RESERVE_MB = 1500   # pyannote 3.1 model + clustering tensors
SAFETY_MARGIN_MB = 500       # transient PyTorch allocator overhead

MODEL_CATALOG = [
    # --- Llama family (Meta) ---
    {
        "id": "llama3.2:1b", "name": "Llama 3.2 1B", "vendor": "Meta",
        "size_mb": 1300, "vram_mb": 800,
        "quality": "good", "speed": "very_fast",
        "description": "Tiny, fast, runs on almost any GPU. Good for short meetings.",
    },
    {
        "id": "llama3.2:3b", "name": "Llama 3.2 3B", "vendor": "Meta",
        "size_mb": 2000, "vram_mb": 2400,
        "quality": "very_good", "speed": "fast",
        "description": "Sweet spot for quality on mid-range GPUs.",
    },
    {
        "id": "llama3.3:70b", "name": "Llama 3.3 70B", "vendor": "Meta",
        "size_mb": 40000, "vram_mb": 42000,
        "quality": "best", "speed": "slow",
        "description": "Frontier-level quality. Needs serious VRAM (A100/H100 or 2x 4090).",
    },
    # --- Qwen family (Alibaba) ---
    {
        "id": "qwen2.5:1.5b", "name": "Qwen 2.5 1.5B", "vendor": "Alibaba",
        "size_mb": 990, "vram_mb": 1100,
        "quality": "very_good", "speed": "fast",
        "description": "Punches above its weight. Great multilingual.",
    },
    {
        "id": "qwen2.5:7b", "name": "Qwen 2.5 7B", "vendor": "Alibaba",
        "size_mb": 4400, "vram_mb": 4500,
        "quality": "very_good", "speed": "fast",
        "description": "Solid all-rounder for mid GPUs.",
    },
    {
        "id": "qwen2.5:14b", "name": "Qwen 2.5 14B", "vendor": "Alibaba",
        "size_mb": 8800, "vram_mb": 9000,
        "quality": "excellent", "speed": "fast",
        "description": "High quality, fits 12GB+ GPUs.",
    },
    {
        "id": "qwen2.5:32b", "name": "Qwen 2.5 32B", "vendor": "Alibaba",
        "size_mb": 18500, "vram_mb": 19000,
        "quality": "excellent", "speed": "medium",
        "description": "Top-tier reasoning. Needs 24GB+.",
    },
    # --- Gemma 3 (Google) ---
    {
        "id": "gemma3:1b", "name": "Gemma 3 1B", "vendor": "Google",
        "size_mb": 815, "vram_mb": 850,
        "quality": "good", "speed": "fast",
        "description": "Compact and efficient.",
    },
    {
        "id": "gemma3:12b", "name": "Gemma 3 12B", "vendor": "Google",
        "size_mb": 7800, "vram_mb": 8000,
        "quality": "excellent", "speed": "fast",
        "description": "Excellent quality at moderate VRAM.",
    },
    {
        "id": "gemma3:27b", "name": "Gemma 3 27B", "vendor": "Google",
        "size_mb": 16600, "vram_mb": 17000,
        "quality": "excellent", "speed": "fast",
        "description": "Heavy-weight Gemma. 18GB+ VRAM.",
    },
    # --- Gemma 4 (Google, NEW April 2026) ---
    {
        "id": "gemma4:e2b", "name": "Gemma 4 E2B", "vendor": "Google",
        "size_mb": 7200, "vram_mb": 4000,
        "quality": "very_good", "speed": "fast",
        "new": True,
        "description": "NEW. Multimodal, 256K context. Effective 2B params, 4GB VRAM.",
    },
    {
        "id": "gemma4:e4b", "name": "Gemma 4 E4B", "vendor": "Google",
        "size_mb": 9600, "vram_mb": 6000,
        "quality": "excellent", "speed": "fast",
        "new": True,
        "description": "NEW. Default Gemma 4. Best quality at 6GB.",
    },
    {
        "id": "gemma4:26b-a4b", "name": "Gemma 4 26B MoE", "vendor": "Google",
        "size_mb": 18000, "vram_mb": 18000,
        "quality": "excellent", "speed": "fast",
        "new": True,
        "description": "NEW. Mixture of Experts. #6 worldwide on Arena.",
    },
    {
        "id": "gemma4:31b", "name": "Gemma 4 31B", "vendor": "Google",
        "size_mb": 20000, "vram_mb": 20000,
        "quality": "best", "speed": "medium",
        "new": True,
        "description": "NEW. Dense 31B. #3 worldwide open model on Arena.",
    },
]


def model_fits_gpu(model, free_vram_mb):
    """A model is GPU-safe if loading it leaves enough VRAM for pyannote + safety margin."""
    needed = model["vram_mb"] + PYANNOTE_RESERVE_MB + SAFETY_MARGIN_MB
    return free_vram_mb >= needed


def pick_default_model(free_vram_mb):
    """Pick the highest-quality model that fits the GPU.

    Tie-break: respect catalog order (Llama before Qwen before Gemma) so the picker
    is deterministic and the user-requested default (llama3.2:1b for low-VRAM GPUs)
    is honored. Falls back to the smallest LLM if nothing fits.
    """
    quality_rank = {"good": 1, "very_good": 2, "excellent": 3, "best": 4}
    fitting = [(i, m) for i, m in enumerate(MODEL_CATALOG) if model_fits_gpu(m, free_vram_mb)]
    if fitting:
        # Highest quality desc, then earliest in catalog asc
        fitting.sort(key=lambda x: (-quality_rank.get(x[1].get("quality"), 0), x[0]))
        return fitting[0][1]
    # Nothing fits on GPU → smallest model (will run on CPU)
    cpu_fallback = sorted(MODEL_CATALOG, key=lambda m: m["vram_mb"])
    return cpu_fallback[0] if cpu_fallback else None


def get_hardware_info():
    """Return current hardware capabilities + which models are GPU-compatible.

    Frontend uses this to render the model picker, hiding/disabling models
    that would crash pyannote.
    """
    info = {
        "gpu_available": False,
        "gpu_name": None,
        "total_vram_mb": 0,
        "free_vram_mb": 0,
        "pyannote_reserve_mb": PYANNOTE_RESERVE_MB,
        "safety_margin_mb": SAFETY_MARGIN_MB,
        "tier": "cpu_only",
        "default_model": None,
        "models": [],
    }
    try:
        import torch
        if torch.cuda.is_available():
            free_b, total_b = torch.cuda.mem_get_info(0)
            info["gpu_available"] = True
            info["gpu_name"] = torch.cuda.get_device_name(0)
            info["total_vram_mb"] = int(total_b // 1024 // 1024)
            info["free_vram_mb"] = int(free_b // 1024 // 1024)
    except Exception as e:
        print(f"[heed] hardware probe failed: {e}", flush=True)

    # Tier classifies the HARDWARE (use total VRAM), not current state.
    # Free VRAM is what we use to filter individual models below.
    total = info["total_vram_mb"]
    free = info["free_vram_mb"]
    if total >= 22000:
        info["tier"] = "ultra"
    elif total >= 14000:
        info["tier"] = "high"
    elif total >= 7000:
        info["tier"] = "mid"
    elif total >= 3000:
        info["tier"] = "low"
    else:
        info["tier"] = "cpu_only"

    # `gpu_compatible` is a property of the HARDWARE, not the current memory state.
    # We compute it against TOTAL VRAM so the answer is stable across reboots and
    # whatever Chrome / Steam / random GPU consumer is running.
    #
    # `gpu_runtime_ok` reflects what actually fits RIGHT NOW (free VRAM). The UI
    # uses this to warn the user if they need to free memory before installing a
    # large model — but it does NOT use it to hide models from the catalog.
    for m in MODEL_CATALOG:
        gpu_ok = info["gpu_available"] and model_fits_gpu(m, total)
        runtime_ok = info["gpu_available"] and model_fits_gpu(m, free)
        info["models"].append({
            **m,
            "gpu_compatible": gpu_ok,
            "gpu_runtime_ok": runtime_ok,
            "recommended_runtime": "gpu" if gpu_ok else "cpu",
        })

    # Default model is picked against TOTAL VRAM too — what the hardware can run,
    # not what the current Chrome state allows. Runtime issues are surfaced later.
    default = pick_default_model(total)
    info["default_model"] = default["id"] if default else None
    return info


def get_device_config():
    """Auto-detect hardware and decide where each model runs.

    Strategy is based on FREE VRAM at startup, not total — because Ollama or other
    GPU consumers may be hogging memory. We need >=1.5GB free to safely run pyannote
    inference (model + temp tensors during clustering).

    - >=6GB free: both on GPU
    - 1.5-6GB free: pyannote on GPU (it benefits more), whisper on CPU
    - <1.5GB free: both on CPU
    - No CUDA: both on CPU
    """
    import torch

    if not torch.cuda.is_available():
        print("[heed] No CUDA — using CPU for all models", flush=True)
        return {"whisper": "cpu", "pyannote": "cpu"}

    free_bytes, total_bytes = torch.cuda.mem_get_info(0)
    free_mb = free_bytes // 1024 // 1024
    total_mb = total_bytes // 1024 // 1024
    gpu_name = torch.cuda.get_device_name(0)
    print(f"[heed] GPU: {gpu_name} ({total_mb}MB total, {free_mb}MB free)", flush=True)

    if free_mb >= 6000:
        print("[heed] Strategy: both models on GPU", flush=True)
        return {"whisper": "cuda", "pyannote": "cuda"}
    elif free_mb >= 1500:
        # Pyannote benefits MORE from GPU than whisper (25s→5s vs 9s→5s)
        print(f"[heed] Strategy: pyannote on GPU, whisper on CPU ({free_mb}MB free)", flush=True)
        return {"whisper": "cpu", "pyannote": "cuda"}
    else:
        print(f"[heed] Strategy: both on CPU (only {free_mb}MB free, need >=1500MB for pyannote on GPU)", flush=True)
        return {"whisper": "cpu", "pyannote": "cpu"}


def load_models():
    global whisper_model, diarize_pipeline

    devices = get_device_config()

    # --- Whisper ---
    print(f"[heed] Loading whisper small on {devices['whisper']}...", flush=True)
    t = time.time()
    os.environ.pop("HF_HUB_OFFLINE", None)
    os.environ.pop("TRANSFORMERS_OFFLINE", None)
    import whisper
    whisper_model = whisper.load_model("small", device=devices["whisper"])
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    models_ready["whisper"] = True
    print(f"[heed] Whisper ready in {time.time()-t:.1f}s ({devices['whisper']})", flush=True)

    # --- Pyannote ---
    print(f"[heed] Loading pyannote on {devices['pyannote']}...", flush=True)
    t = time.time()
    import torch
    from pyannote.audio import Pipeline
    diarize_pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")
    if devices["pyannote"] == "cuda":
        diarize_pipeline.to(torch.device("cuda"))
        # Lower batch size for GPUs with limited VRAM (4GB)
        vram = torch.cuda.get_device_properties(0).total_memory // 1024 // 1024
        if vram < 6000:
            diarize_pipeline._segmentation.batch_size = 8
            if hasattr(diarize_pipeline, '_embedding'):
                diarize_pipeline._embedding.batch_size = 8
            print(f"[heed] Reduced batch_size to 8 for {vram}MB VRAM", flush=True)
    models_ready["pyannote"] = True
    print(f"[heed] Pyannote ready in {time.time()-t:.1f}s ({devices['pyannote']})", flush=True)
    print("[heed] All models ready!", flush=True)


# --- Transcription ---
def transcribe(wav_path, language="auto", srt_output=None):
    lang = None if language == "auto" else language
    result = whisper_model.transcribe(wav_path, language=lang)

    srt_lines = []
    plain_lines = []
    for idx, seg in enumerate(result.get("segments", []), 1):
        start_ts = format_ts(seg["start"])
        end_ts = format_ts(seg["end"])
        text = seg["text"].strip()
        srt_lines.append(f"{idx}\n{start_ts} --> {end_ts}\n{text}\n")
        plain_lines.append(text)

    srt_content = "\n".join(srt_lines)
    text = "\n".join(plain_lines) if plain_lines else result.get("text", "").strip()

    srt_path = srt_output or wav_path + ".srt"
    with open(srt_path, "w") as f:
        f.write(srt_content)

    txt_path = wav_path.rsplit(".", 1)[0] + ".txt"
    with open(txt_path, "w") as f:
        f.write(text)

    return {
        "text": text,
        "srt_path": srt_path,
        "txt_path": txt_path,
        "language": result.get("language", language),
    }


def format_ts(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    ms = int((s - int(s)) * 1000)
    return f"{h:02d}:{m:02d}:{int(s):02d},{ms:03d}"


# --- Voice memory (saved speaker embeddings) ---
VOICES_PATH = os.path.join(os.path.expanduser("~"), ".heed-app", "voices.json")

def load_voices():
    if not os.path.exists(VOICES_PATH):
        return {}
    try:
        with open(VOICES_PATH) as f:
            return json.load(f)
    except Exception:
        return {}

def save_voices(voices):
    os.makedirs(os.path.dirname(VOICES_PATH), exist_ok=True)
    with open(VOICES_PATH, "w") as f:
        json.dump(voices, f, indent=2)

def cosine_similarity(a, b):
    import math
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0
    return dot / (norm_a * norm_b)

def match_voice(embedding, threshold=0.7):
    """Compare embedding to all known voices, return best match name or None."""
    voices = load_voices()
    if not voices:
        return None, 0
    best_name = None
    best_score = 0
    for name, saved_emb in voices.items():
        score = cosine_similarity(embedding, saved_emb)
        if score > best_score:
            best_score = score
            best_name = name
    if best_score >= threshold:
        return best_name, best_score
    return None, best_score


# --- Diarization ---
def diarize(wav_path, srt_path=None, min_speakers=None, max_speakers=None):
    # Tune clustering for accuracy (slightly conservative to avoid splitting same voice)
    params = diarize_pipeline.parameters(instantiated=True)
    params["clustering"]["threshold"] = 0.8

    kwargs = {}
    if min_speakers:
        kwargs["min_speakers"] = int(min_speakers)
    if max_speakers:
        kwargs["max_speakers"] = int(max_speakers)

    import torch
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    try:
        result = diarize_pipeline(wav_path, **kwargs)
    except torch.cuda.OutOfMemoryError as oom:
        # Last-ditch fallback: free everything, move pipeline to CPU and retry once.
        # This recovers from situations where Ollama or another GPU consumer pushed
        # us over the limit mid-meeting.
        print(f"[heed] pyannote CUDA OOM — falling back to CPU and retrying: {oom}", flush=True)
        try:
            torch.cuda.empty_cache()
            diarize_pipeline.to(torch.device("cpu"))
            result = diarize_pipeline(wav_path, **kwargs)
        except Exception as e2:
            raise RuntimeError(f"pyannote failed on both GPU and CPU: {e2}") from oom
    annotation = result.speaker_diarization

    # Get speaker embeddings (one per detected speaker)
    embeddings = result.speaker_embeddings  # numpy array, shape (num_speakers, embedding_dim)

    # Build speaker map: pyannote label -> human name
    raw_labels = list(annotation.labels())
    speakers_map = {}
    speaker_embeddings = {}
    counter = 0

    for i, raw_label in enumerate(raw_labels):
        emb = embeddings[i].tolist() if i < len(embeddings) else None

        # Try to match against known voices
        matched_name = None
        if emb:
            matched_name, _ = match_voice(emb)

        if matched_name:
            speakers_map[raw_label] = matched_name
        else:
            counter += 1
            speakers_map[raw_label] = f"Speaker {counter}"

        if emb:
            speaker_embeddings[speakers_map[raw_label]] = emb

    # Build segments using the human labels
    diar_segments = []
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        diar_segments.append({
            "start": round(turn.start, 2),
            "end": round(turn.end, 2),
            "speaker": speakers_map[speaker],
        })

    # Merge with SRT if provided
    if srt_path and os.path.exists(srt_path):
        srt_segments = parse_srt(srt_path)
        merged = assign_speakers(diar_segments, srt_segments)
        lines = []
        last = None
        for seg in merged:
            if seg["speaker"] != last:
                lines.append(f"\n{seg['speaker']}:")
                last = seg["speaker"]
            lines.append(f"  {seg['text']}")
        text = "\n".join(lines).strip()
    else:
        merged = diar_segments
        text = ""

    return {
        "speakers": list(set(speakers_map.values())),
        "speaker_count": len(set(speakers_map.values())),
        "segments": merged,
        "text": text,
        "embeddings": speaker_embeddings,  # { "Speaker 1": [...], "Junior": [...] }
    }


def parse_srt(srt_path):
    import re
    with open(srt_path) as f:
        content = f.read()
    blocks = re.split(r"\n\n+", content.strip())
    segments = []
    for block in blocks:
        lines = block.strip().split("\n")
        ts_line = next((l for l in lines if "-->" in l), None)
        if not ts_line:
            continue
        ts_line = ts_line.replace(",", ".").strip("[] ")
        match = re.match(r"(\d+):(\d+):([\d.]+)\s*-->\s*(\d+):(\d+):([\d.]+)", ts_line)
        if not match:
            continue
        start = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
        end = int(match[4]) * 3600 + int(match[5]) * 60 + float(match[6])
        found_ts = False
        text_parts = []
        for l in lines:
            if "-->" in l:
                found_ts = True
                continue
            if found_ts:
                text_parts.append(l.strip())
        text = " ".join(text_parts).strip()
        if text:
            segments.append({"start": start, "end": end, "text": text})
    return segments


def assign_speakers(diar_segs, srt_segs):
    result = []
    for seg in srt_segs:
        mid = (seg["start"] + seg["end"]) / 2
        best_speaker = "Speaker ?"
        best_overlap = 0
        for d in diar_segs:
            ov = max(0, min(seg["end"], d["end"]) - max(seg["start"], d["start"]))
            if ov > best_overlap:
                best_overlap = ov
                best_speaker = d["speaker"]
        if best_overlap == 0:
            for d in diar_segs:
                if d["start"] <= mid <= d["end"]:
                    best_speaker = d["speaker"]
                    break
        result.append({"speaker": best_speaker, "start": seg["start"], "end": seg["end"], "text": seg["text"]})
    return result


# --- Full processing (transcribe first, then diarize with SRT) ---
def process_full(wav_path, language="auto", do_diarize=False, min_speakers=None, max_speakers=None):
    results = {}

    # Step 1: Transcribe (fast on GPU, ~5s)
    try:
        results["transcribe"] = transcribe(wav_path, language)
    except Exception as e:
        results["transcribe"] = {"error": str(e)}

    # Step 2: Diarize with SRT for speaker-text merge (slower, ~25s on CPU)
    if do_diarize and "error" not in results.get("transcribe", {}):
        try:
            srt_path = results["transcribe"].get("srt_path")
            results["diarize"] = diarize(wav_path, srt_path, min_speakers, max_speakers)
        except Exception as e:
            results["diarize"] = {"error": str(e)}

    return results


# --- Channel-based diarization (the killer feature) ---
# Input is a stereo WAV where L=mic (you) and R=system (other party).
# We split, transcribe each independently, run pyannote ONLY on system
# (your mic is always you = "Me"), then merge timelines and flag overlaps.
def split_stereo(wav_path):
    """Split a stereo WAV into two mono WAVs (mic, sys). Returns (mic_path, sys_path)."""
    base = wav_path.rsplit(".", 1)[0]
    mic_path = f"{base}-mic.wav"
    sys_path = f"{base}-sys.wav"
    # pan filter is the most reliable way to extract a single channel as mono
    for out, channel in ((mic_path, "c0"), (sys_path, "c1")):
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", wav_path,
                "-af", f"pan=mono|c0={channel}",
                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
                out,
            ],
            check=True,
        )
    return mic_path, sys_path


def channel_has_audio(wav_path, threshold_db=-50.0):
    """Quick energy check — skip transcription on a silent channel to save time."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-i", wav_path, "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True, text=True,
        )
        for line in result.stderr.split("\n"):
            if "mean_volume:" in line:
                db = float(line.split("mean_volume:")[1].strip().split()[0])
                return db > threshold_db
    except Exception:
        pass
    return True  # if check fails, assume audio present


def process_dual(wav_path, language="auto", min_speakers=None, max_speakers=None):
    """Channel-based diarization for dual-channel captures.

    L=mic → always labeled "Me", no diarization needed (it's your voice).
    R=sys → whisper + pyannote, labels become Speaker 1, 2, …
    Then we merge by timestamp and flag overlaps.
    """
    mic_path, sys_path = split_stereo(wav_path)

    mic_has = channel_has_audio(mic_path)
    sys_has = channel_has_audio(sys_path)

    # Step 1: Transcribe both channels SEQUENTIALLY.
    # Whisper's nn.Module is NOT thread-safe — running two model.transcribe() calls
    # concurrently on the same instance corrupts internal tensors and one of them
    # silently dies with "Linear(in_features=768, ...)" errors.
    # Sequential is also faster on CPU since BLAS already parallelizes inside one call.
    mic_tx = {"text": "", "srt_path": None, "language": language}
    sys_tx = {"text": "", "srt_path": None, "language": language}

    if mic_has:
        try:
            mic_tx = transcribe(mic_path, language)
        except Exception as e:
            print(f"[heed] dual mic transcribe failed: {e}", flush=True)

    if sys_has:
        try:
            sys_tx = transcribe(sys_path, language)
        except Exception as e:
            print(f"[heed] dual sys transcribe failed: {e}", flush=True)

    # Step 2: Build mic segments (all "Me")
    mic_segments = []
    if mic_tx.get("srt_path") and os.path.exists(mic_tx["srt_path"]):
        for s in parse_srt(mic_tx["srt_path"]):
            mic_segments.append({
                "speaker": "Me",
                "start": s["start"],
                "end": s["end"],
                "text": s["text"],
                "channel": "mic",
            })

    # Step 3: Diarize sys channel (only this needs pyannote)
    sys_segments = []
    sys_speakers_meta = {"speakers": [], "embeddings": {}}
    sys_diar_ok = False
    if sys_has and sys_tx.get("srt_path"):
        try:
            sys_diar = diarize(sys_path, sys_tx["srt_path"], min_speakers, max_speakers)
            for s in sys_diar.get("segments", []):
                sys_segments.append({
                    "speaker": s["speaker"],
                    "start": s["start"],
                    "end": s["end"],
                    "text": s.get("text", ""),
                    "channel": "sys",
                })
            sys_speakers_meta["speakers"] = sys_diar.get("speakers", [])
            sys_speakers_meta["embeddings"] = sys_diar.get("embeddings", {})
            sys_diar_ok = True
        except Exception as e:
            print(f"[heed] sys diarize failed (falling back to single speaker): {e}", flush=True)

    # Fallback: if diarize failed, still emit the sys transcript as a single "Speaker 1".
    # This is critical — losing the entire other party's transcript because pyannote OOM'd
    # would be a brutal user experience.
    if sys_has and not sys_diar_ok and sys_tx.get("srt_path") and os.path.exists(sys_tx["srt_path"]):
        for s in parse_srt(sys_tx["srt_path"]):
            sys_segments.append({
                "speaker": "Speaker 1",
                "start": s["start"],
                "end": s["end"],
                "text": s["text"],
                "channel": "sys",
            })
        sys_speakers_meta["speakers"] = ["Speaker 1"]

    # Step 4: Merge by timestamp + detect overlaps
    all_segments = sorted(mic_segments + sys_segments, key=lambda s: s["start"])
    OVERLAP_MIN = 0.3  # 300ms — ignore tiny crossings
    for ms in mic_segments:
        for ss in sys_segments:
            ov = max(0, min(ms["end"], ss["end"]) - max(ms["start"], ss["start"]))
            if ov >= OVERLAP_MIN:
                ms["overlap"] = True
                ss["overlap"] = True

    # Step 5: Build chronological transcript with speaker headers
    lines = []
    last = None
    for seg in all_segments:
        if seg["speaker"] != last:
            lines.append(f"\n{seg['speaker']}:")
            last = seg["speaker"]
        marker = "  ⟳" if seg.get("overlap") else ""
        lines.append(f"  {seg['text']}{marker}")
    diar_text = "\n".join(lines).strip()

    plain_text = "\n".join(seg["text"] for seg in all_segments if seg["text"]).strip()

    speakers = []
    if mic_segments:
        speakers.append("Me")
    speakers.extend(sys_speakers_meta["speakers"])
    # Dedupe preserving order
    seen = set()
    speakers = [s for s in speakers if not (s in seen or seen.add(s))]

    return {
        "transcribe": {
            "text": plain_text,
            "srt_path": sys_tx.get("srt_path") or mic_tx.get("srt_path") or "",
            "txt_path": (sys_tx.get("txt_path") or mic_tx.get("txt_path") or ""),
            "language": (sys_tx.get("language") or mic_tx.get("language") or language),
        },
        "diarize": {
            "speakers": speakers,
            "speaker_count": len(speakers),
            "segments": all_segments,
            "text": diar_text,
            "embeddings": sys_speakers_meta["embeddings"],
        },
    }


# --- HTTP Server ---
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # suppress logs

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._json({"ready": all(models_ready.values()), **models_ready})
        elif self.path == "/voices":
            self._json({"voices": list(load_voices().keys())})
        elif self.path == "/hardware":
            self._json(get_hardware_info())
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if self.path == "/transcribe":
            if not models_ready["whisper"]:
                self._json({"error": "whisper not loaded"}, 503)
                return
            t = time.time()
            result = transcribe(
                body["wav_path"],
                body.get("language", "auto"),
                body.get("srt_output"),
            )
            result["time_ms"] = int((time.time() - t) * 1000)
            self._json(result)

        elif self.path == "/diarize":
            if not models_ready["pyannote"]:
                self._json({"error": "pyannote not loaded"}, 503)
                return
            t = time.time()
            result = diarize(
                body["wav_path"],
                body.get("srt_path"),
                body.get("min_speakers"),
                body.get("max_speakers"),
            )
            result["time_ms"] = int((time.time() - t) * 1000)
            self._json(result)

        elif self.path == "/process":
            t = time.time()
            if body.get("dual_channel"):
                # Channel-based diarization for stereo captures (L=mic, R=system)
                if not models_ready["whisper"] or not models_ready["pyannote"]:
                    self._json({"error": "models not ready"}, 503)
                    return
                try:
                    result = process_dual(
                        body["wav_path"],
                        body.get("language", "auto"),
                        body.get("min_speakers"),
                        body.get("max_speakers"),
                    )
                except Exception as e:
                    self._json({"error": f"process_dual failed: {e}"}, 500)
                    return
            else:
                result = process_full(
                    body["wav_path"],
                    body.get("language", "auto"),
                    body.get("diarize", False),
                    body.get("min_speakers"),
                    body.get("max_speakers"),
                )
            result["total_time_ms"] = int((time.time() - t) * 1000)
            self._json(result)

        elif self.path == "/voices/save":
            # body: { name: "Junior", embedding: [...] }
            name = body.get("name", "").strip()
            emb = body.get("embedding")
            if not name or not emb:
                self._json({"error": "name and embedding required"}, 400)
                return
            voices = load_voices()
            voices[name] = emb
            save_voices(voices)
            self._json({"ok": True, "name": name, "total": len(voices)})

        elif self.path == "/voices/delete":
            name = body.get("name", "").strip()
            voices = load_voices()
            if name in voices:
                del voices[name]
                save_voices(voices)
            self._json({"ok": True})

        else:
            self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    # Load models in background
    loader = threading.Thread(target=load_models, daemon=True)
    loader.start()

    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[heed] Transcription server on :{PORT}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()

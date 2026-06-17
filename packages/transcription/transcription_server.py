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
import re
import sys
import time
import warnings
import threading
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from concurrent.futures import ThreadPoolExecutor

# Threading HTTP server so health/hardware checks don't block while whisper is processing.
# Without this, the server is single-threaded and ANY request during transcription hangs.
class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

# Locks to prevent concurrent calls to the same whisper model (not thread-safe).
# Different model instances (final vs live) CAN run concurrently.
whisper_lock = threading.Lock()
whisper_live_lock = threading.Lock()

warnings.filterwarnings("ignore")
# HF_HUB_OFFLINE is set AFTER model loading in load_models() so that
# first-time downloads (auto-picked whisper models) can reach HuggingFace.

PORT = int(os.environ.get("HEED_TRANSCRIPTION_PORT", "5002"))

# Stable-by-default profile to prioritize transcript quality/reliability.
# Set HEED_TRANSCRIPTION_PROFILE=adaptive to re-enable aggressive auto-tuning.
TRANSCRIPTION_PROFILE = (os.environ.get("HEED_TRANSCRIPTION_PROFILE", "stable") or "stable").strip().lower()
if TRANSCRIPTION_PROFILE not in {"stable", "adaptive"}:
    TRANSCRIPTION_PROFILE = "stable"

# --- Model loading (once, kept in memory) ---
whisper_model = None  # final transcription model
whisper_model_live = None  # live chunk model (lighter, for low-latency preview)
whisper_model_name = "small"
whisper_model_live_name = "small"
# RuntimeGovernor + the bits it needs to hot-swap the live model under contention.
live_governor = None
_devices = None
_warmup_path = None
# Per-engine LIVE cadence hint the Node server reads from /health. Parakeet (Apple Neural
# Engine, ~50ms per chunk) can poll fast with short windows → near-instant words on screen.
# Whisper engines keep the safe 3s/2000ms cadence so slow CPUs never starve mid-recording.
# Measured: Parakeet needs >=2s of audio to emit clean text (1s -> empty, 1.5s -> clipped).
live_tuning = {"chunk_s": 3.0, "interval_ms": 2000, "mode": "chunk"}
# Active transcription engine ("parakeet" | "mlx" | "ctranslate2"), set in load_models().
# Drives which languages the UI may offer (Parakeet = 28 European; Whisper = all).
active_engine = "ctranslate2"
whisper_runtime_info = {
    "final_model": "small",
    "live_model": "base",
    "device": "cpu",
    "quality": "very_good",
    "speed": "fast",
    "reason": "initializing",
}
pyannote_runtime_info = {
    "model": "pyannote/speaker-diarization-3.1",
    "device": "cpu",
    "profile": "balanced",
    "batch_size": 8,
    "reason": "initializing",
}
diarize_pipeline = None
# Which backend answers diarization: "pyannote" (Linux/CUDA/CPU) or "parakeet" (Apple
# Silicon, via the FluidAudio sidecar — no gated HF token). None = diarization off.
diarize_backend = None
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

    # Default model is picked against FREE VRAM — the one that works RIGHT NOW.
    # If we recommend a model that doesn't fit free VRAM, the user downloads it,
    # Ollama loads it, steals VRAM from pyannote, and everything OOMs.
    # The catalog still uses TOTAL (so we don't hide models), but "recommended"
    # must be something that runs on first click without closing anything.
    default = pick_default_model(free)
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

    cpu_count = os.cpu_count() or 0
    ram_mb = get_system_ram_mb()

    # Apple Silicon MPS (Metal Performance Shaders) support
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        print(f"[heed] Apple Silicon MPS detected ({cpu_count} cores, {ram_mb}MB RAM)", flush=True)
        print("[heed] Strategy: pyannote on MPS, whisper on CPU", flush=True)
        return {
            "whisper": "cpu",  # faster-whisper uses CTranslate2, not PyTorch — CPU is fastest
            "pyannote": "mps",
            "gpu_available": True,
            "gpu_name": "Apple Silicon (MPS)",
            "total_vram_mb": ram_mb,  # MPS shares system RAM
            "free_vram_mb": ram_mb // 2,  # conservative estimate
        }

    if not torch.cuda.is_available():
        print(f"[heed] No CUDA/MPS — using CPU for all models ({cpu_count} cores, {ram_mb}MB RAM)", flush=True)
        return {
            "whisper": "cpu",
            "pyannote": "cpu",
            "gpu_available": False,
            "gpu_name": None,
            "free_vram_mb": 0,
            "total_vram_mb": 0,
            "cpu_count": cpu_count,
            "ram_mb": ram_mb,
        }

    free_bytes, total_bytes = torch.cuda.mem_get_info(0)
    free_mb = free_bytes // 1024 // 1024
    total_mb = total_bytes // 1024 // 1024
    gpu_name = torch.cuda.get_device_name(0)
    print(f"[heed] GPU: {gpu_name} ({total_mb}MB total, {free_mb}MB free)", flush=True)

    if free_mb >= 6000:
        print("[heed] Strategy: both models on GPU", flush=True)
        return {
            "whisper": "cuda",
            "pyannote": "cuda",
            "gpu_available": True,
            "gpu_name": gpu_name,
            "free_vram_mb": int(free_mb),
            "total_vram_mb": int(total_mb),
            "cpu_count": cpu_count,
            "ram_mb": ram_mb,
        }
    elif free_mb >= 1500:
        # Pyannote benefits MORE from GPU than whisper (25s→5s vs 9s→5s)
        print(f"[heed] Strategy: pyannote on GPU, whisper on CPU ({free_mb}MB free)", flush=True)
        return {
            "whisper": "cpu",
            "pyannote": "cuda",
            "gpu_available": True,
            "gpu_name": gpu_name,
            "free_vram_mb": int(free_mb),
            "total_vram_mb": int(total_mb),
            "cpu_count": cpu_count,
            "ram_mb": ram_mb,
        }
    else:
        print(f"[heed] Strategy: both on CPU (only {free_mb}MB free, need >=1500MB for pyannote on GPU)", flush=True)
        return {
            "whisper": "cpu",
            "pyannote": "cpu",
            "gpu_available": True,
            "gpu_name": gpu_name,
            "free_vram_mb": int(free_mb),
            "total_vram_mb": int(total_mb),
            "cpu_count": cpu_count,
            "ram_mb": ram_mb,
        }


def get_system_ram_mb():
    """Best-effort total system RAM (MB) without external deps like psutil."""
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        phys_pages = os.sysconf("SC_PHYS_PAGES")
        if page_size and phys_pages:
            return int((page_size * phys_pages) // 1024 // 1024)
    except Exception:
        pass
    return 0


def pick_whisper_models(device_cfg):
    """Auto-select whisper model based on hardware power.

    Progressive scaling — starts at base, goes up with hardware:
      base    → entry level (laptop, 4-8GB RAM, weak CPU)
      small   → mid range (12+ cores, 12-16GB RAM, or any GPU)  ← your GTX 1650
      medium  → high end (16+ cores, 24GB+ RAM, or 8GB+ VRAM)
      large-v3→ ultra (24+ cores, 32GB+ RAM, or 16GB+ VRAM)

    Live and final ALWAYS use the same model (same quality, shared instance).
    """
    cpu_count = int(device_cfg.get("cpu_count", os.cpu_count() or 0) or 0)
    ram_mb = int(device_cfg.get("ram_mb", get_system_ram_mb()) or 0)
    whisper_device = device_cfg.get("whisper", "cpu")
    free_vram = int(device_cfg.get("free_vram_mb", 0) or 0)

    # Whisper accuracy tiers (ascending). Footprint ≈ runtime memory in MB. `large-v3` is the
    # 4-bit MLX build (measured: same accuracy as fp16, ~1.5x faster, ~1/3 the memory).
    TIERS = ["base", "small", "medium", "large-v3"]
    TIER_MEM_MB = {"base": 200, "small": 600, "medium": 1600, "large-v3": 1200}

    model = "base"
    gpu_fast = whisper_device == "cuda" or "Apple Silicon" in str(device_cfg.get("gpu_name", ""))

    if gpu_fast:
        # On a fast accelerator (Apple GPU via MLX, or NVIDIA/CUDA) bigger models run in a
        # fraction of real time, so we pick the LARGEST tier that fits the memory headroom —
        # giving each machine its best accuracy. "Marvel on any hardware" = best that fits,
        # never a fixed model.
        total_mem = int(device_cfg.get("total_vram_mb", 0) or 0) or ram_mb  # VRAM (CUDA) or unified RAM (Apple)
        # Headroom budget for the FINAL model: leave room for pyannote (~1.5GB), the live model,
        # Ollama and the OS so we never push past ~80% and collapse the machine.
        budget = max(0, int(free_vram) - 1800)
        # Hard cap by total-memory class so low-RAM machines don't over-reach.
        if total_mem >= 16000:
            cap = "large-v3"
        elif total_mem >= 11000:
            cap = "medium"
        elif total_mem >= 7000:
            cap = "small"
        else:
            cap = "base"
        cap_i = TIERS.index(cap)
        for i, tier in enumerate(TIERS):
            if i <= cap_i and TIER_MEM_MB[tier] <= budget:
                model = tier
        reason = f"{model} (GPU-fast, {total_mem}MB mem, {budget}MB budget, cap={cap})"
    else:
        # CPU-only: large models can't keep up in real time — scale conservatively by cores+RAM.
        if cpu_count >= 24 and ram_mb >= 32000:
            model, reason = "large-v3", f"large-v3 (CPU ultra, {cpu_count} cores, {ram_mb}MB RAM)"
        elif cpu_count >= 16 and ram_mb >= 24000:
            model, reason = "medium", f"medium (CPU high, {cpu_count} cores, {ram_mb}MB RAM)"
        elif cpu_count >= 8 and ram_mb >= 12000:
            model, reason = "small", f"small (CPU mid, {cpu_count} cores, {ram_mb}MB RAM)"
        else:
            model, reason = "base", f"base (CPU entry, {cpu_count} cores, {ram_mb}MB RAM)"

    # LIVE preview model: cap at `small` on GPU. `medium`/`large` for live regressed latency
    # badly during active recording (GPU/CPU contention with the recorder), and `small` is
    # already accurate + fast (~0.3s/chunk). The final pass uses the big `model` for accuracy.
    if gpu_fast:
        live_model = model if model in ("tiny", "base", "small") else "small"
    else:
        live_model = model if model in ("tiny", "base") else "base"

    return {
        "final": model,
        "live": live_model,
        "reason": reason,
    }


def pick_pyannote_tuning(device_cfg):
    """Pick pyannote tuning profile.

    Stable profile (default): conservative known-good batch size.
    Adaptive profile (opt-in): scales aggressively with hardware.
    """
    device = device_cfg.get("pyannote", "cpu")
    free_mb = int(device_cfg.get("free_vram_mb", 0) or 0)
    cpu_count = int(device_cfg.get("cpu_count", os.cpu_count() or 0) or 0)
    ram_mb = int(device_cfg.get("ram_mb", get_system_ram_mb()) or 0)

    if TRANSCRIPTION_PROFILE != "adaptive":
        return {
            "device": device,
            "profile": "stable",
            "batch_size": 8,
            "reason": "stable profile (known-good, conservative batch=8)",
        }

    if device == "cuda":
        if free_mb >= 14000:
            return {
                "device": "cuda",
                "profile": "max",
                "batch_size": 32,
                "reason": f"high free VRAM ({free_mb}MB)",
            }
        if free_mb >= 9000:
            return {
                "device": "cuda",
                "profile": "high",
                "batch_size": 24,
                "reason": f"mid-high free VRAM ({free_mb}MB)",
            }
        if free_mb >= 5000:
            return {
                "device": "cuda",
                "profile": "balanced",
                "batch_size": 16,
                "reason": f"mid free VRAM ({free_mb}MB)",
            }
        if free_mb >= 2500:
            return {
                "device": "cuda",
                "profile": "safe",
                "batch_size": 10,
                "reason": f"low free VRAM ({free_mb}MB)",
            }
        return {
            "device": "cuda",
            "profile": "minimum",
            "batch_size": 8,
            "reason": f"very low free VRAM ({free_mb}MB)",
        }

    cpu_threads = max(2, min(16, cpu_count))
    if cpu_count >= 16 and ram_mb >= 24000:
        return {
            "device": "cpu",
            "profile": "cpu-max",
            "batch_size": 12,
            "cpu_threads": cpu_threads,
            "reason": f"strong CPU ({cpu_count} cores, {ram_mb}MB RAM)",
        }
    return {
        "device": "cpu",
        "profile": "cpu-balanced",
        "batch_size": 8,
        "cpu_threads": max(2, min(12, cpu_threads)),
        "reason": f"standard CPU ({cpu_count} cores, {ram_mb}MB RAM)",
    }


_WHISPER_FALLBACK_ORDER = ["large-v3", "medium", "small", "base", "tiny"]


def _load_whisper_with_fallback(model_name, devices, warmup_path, label="whisper"):
    """Load `model_name`; if it fails (OOM, missing download, etc.) step DOWN through smaller
    tiers until one loads. The warm-up transcribe doubles as a load/compile validation. Returns
    (engine, actual_model_name) and never hard-fails unless EVERY tier fails."""
    import engines
    start = _WHISPER_FALLBACK_ORDER.index(model_name) if model_name in _WHISPER_FALLBACK_ORDER else _WHISPER_FALLBACK_ORDER.index("small")
    for name in _WHISPER_FALLBACK_ORDER[start:]:
        try:
            eng = engines.make_engine(name, devices)
            list(eng.transcribe(warmup_path, language="en")[0])  # validates real load + compile
            if name != model_name:
                print(f"[heed] {label}: '{model_name}' unavailable — degraded to '{name}'", flush=True)
            return eng, name
        except Exception as e:
            print(f"[heed] {label}: '{name}' failed to load ({str(e)[:80]}); stepping down...", flush=True)
    raise RuntimeError(f"{label}: no whisper model could be loaded")


def _swap_live_model(new_model):
    """Hot-swap the live preview model when the governor decides to degrade/recover.
    Loads + warms the new model OUTSIDE the transcribe lock, then swaps the reference under it."""
    global whisper_model_live, whisper_model_live_name
    try:
        eng, name = _load_whisper_with_fallback(new_model, _devices, _warmup_path, "live-swap")
        with whisper_live_lock:
            whisper_model_live = eng
            whisper_model_live_name = name
        print(f"[heed] Governor: live model -> {name}", flush=True)
        return True
    except Exception as e:
        print(f"[heed] Governor: live swap failed ({str(e)[:80]})", flush=True)
        return False


def load_models():
    global whisper_model, whisper_model_live, diarize_pipeline, whisper_model_name, whisper_model_live_name, whisper_runtime_info, pyannote_runtime_info, diarize_backend
    global live_governor, _devices, _warmup_path, live_tuning, active_engine

    devices = get_device_config()
    _devices = devices
    print(f"[heed] Transcription profile: {TRANSCRIPTION_PROFILE}", flush=True)

    # --- Hardware-aware model selection: CapabilityProbe -> ModelPolicy -> verify-the-pick.
    # If anything in the new path fails, fall back to the legacy conservative picker so heed
    # NEVER hard-fails at startup (first robustness guarantee).
    try:
        import capability, policy
        caps = capability.probe(log=lambda m: print(m, flush=True))
        plan = policy.decide(caps, measure_final_rtf=capability.measure_model_rtf)
        whisper_model_name = plan.final_model
        whisper_model_live_name = plan.live_model
        pick_reason = plan.reason
    except Exception as e:
        print(f"[heed] Capability probe failed ({e}) — using legacy picker", flush=True)
        whisper_pick = pick_whisper_models(devices)
        whisper_model_name = whisper_pick["final"]
        whisper_model_live_name = whisper_pick["live"]
        pick_reason = whisper_pick["reason"]
    whisper_quality = "very_good"
    whisper_speed = "fast"
    if whisper_model_name == "medium":
        whisper_quality = "excellent"
        whisper_speed = "medium"
    elif whisper_model_name == "large-v3":
        whisper_quality = "best"
        whisper_speed = "slower"
    whisper_runtime_info = {
        "final_model": whisper_model_name,
        "live_model": whisper_model_live_name,
        "device": devices.get("whisper", "cpu"),
        "quality": whisper_quality,
        "speed": whisper_speed,
        "reason": pick_reason,
    }
    print(
        f"[heed] Whisper auto-pick: final={whisper_model_name}, live={whisper_model_live_name} ({pick_reason})",
        flush=True,
    )

    # --- Whisper engine (hardware-aware: MLX on Apple Silicon, CTranslate2 on CUDA/CPU) ---
    import engines
    engine_kind = engines.select_engine_kind(devices)
    active_engine = engine_kind
    print(f"[heed] Whisper engine: {engine_kind} (final={whisper_model_name}, live={whisper_model_live_name})", flush=True)

    # Build the silent warm-up clip once; it validates each model actually loads.
    _warmup_path = os.path.join(os.path.dirname(__file__), "_warmup.wav")
    try:
        import struct, wave
        with wave.open(_warmup_path, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(struct.pack("<" + "h" * 8000, *([0] * 8000)))
    except Exception:
        pass

    t = time.time()
    whisper_model, whisper_model_name = _load_whisper_with_fallback(whisper_model_name, devices, _warmup_path, "final")
    models_ready["whisper"] = True
    print(f"[heed] Whisper final={whisper_model_name} ready in {time.time()-t:.1f}s ({engine_kind})", flush=True)

    # Live preview: a SEPARATE, lighter model for low latency. Reuse the final instance if they
    # ended up the same name (saves memory). Live also degrades gracefully on its own.
    if whisper_model_live_name and whisper_model_live_name != whisper_model_name:
        t_live = time.time()
        print(f"[heed] Loading live whisper {whisper_model_live_name} ({engine_kind})...", flush=True)
        whisper_model_live, whisper_model_live_name = _load_whisper_with_fallback(whisper_model_live_name, devices, _warmup_path, "live")
        print(f"[heed] Whisper live={whisper_model_live_name} ready in {time.time()-t_live:.1f}s", flush=True)
    else:
        whisper_model_live = whisper_model
        whisper_model_live_name = whisper_model_name
        print(f"[heed] Whisper live = final (same {whisper_model_live_name} instance, saves RAM)", flush=True)

    # Arm the RuntimeGovernor for the live preview: it self-corrects the live model under
    # recording-time contention (the 8-15s regression). Ceiling = the policy's live pick so it
    # never upgrades past what the hardware was judged able to run.
    try:
        from governor import RuntimeGovernor
        live_governor = RuntimeGovernor(start_model=whisper_model_live_name,
                                        ceiling=whisper_model_live_name, floor="tiny")
        print(f"[heed] Live governor armed (start={whisper_model_live_name}, floor=tiny)", flush=True)
    except Exception as e:
        live_governor = None
        print(f"[heed] Live governor unavailable (non-critical): {e}", flush=True)

    # Live strategy, per engine:
    #  - "full" (Parakeet/MLX, fast): RE-TRANSCRIBE the whole growing audio each tick and REPLACE
    #    the on-screen text. Full context = accurate (no word-cutting), and it's affordable because
    #    Parakeet does 30s in ~0.3s. This is the killer live UX Whisper-on-CPU could never do.
    #  - "chunk" (CTranslate2/CPU, slow): keep stitching short 3s chunks — re-transcribing the whole
    #    file each tick would be far too slow on CPU. Safe, proven path.
    if engine_kind in ("parakeet", "mlx"):
        live_tuning = {"chunk_s": 2.0, "interval_ms": 1200, "mode": "full"}
    else:
        live_tuning = {"chunk_s": 3.0, "interval_ms": 2000, "mode": "chunk"}
    print(f"[heed] Live: mode={live_tuning['mode']} interval={live_tuning['interval_ms']}ms ({engine_kind})", flush=True)

    # Now safe to go offline for pyannote
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    # --- Diarization backend selection ---
    # On Apple Silicon, the Parakeet sidecar ALSO loads FluidAudio speaker diarization (CoreML,
    # downloaded from a PUBLIC HF repo — NO gated token). Prefer it: zero-friction install, no
    # pyannote/torch token wall. Everywhere else (Linux/CUDA/CPU) keep pyannote unchanged.
    if engine_kind == "parakeet" and engines.parakeet_available():
        try:
            t = time.time()
            engines.get_parakeet()  # warms the sidecar (ASR + diarization models) if not already
            diarize_backend = "parakeet"
            models_ready["pyannote"] = True
            pyannote_runtime_info = {
                "model": "fluidaudio (CoreML, no token)",
                "device": "ane",
                "profile": "parakeet-sidecar",
                "reason": "Apple Silicon: zero-token diarization via FluidAudio",
            }
            print(f"[heed] Diarization: FluidAudio sidecar (no token) ready in {time.time()-t:.1f}s", flush=True)
            print(f"[heed] All models ready! (whisper=ok, diarization=on via parakeet-sidecar)", flush=True)
            return
        except Exception as e:
            diarize_backend = None
            print(f"[heed] FluidAudio sidecar diarization unavailable ({str(e)[:100]}) — trying pyannote", flush=True)

    # --- Pyannote (OPTIONAL: diarization is a bonus, not a hard requirement) ---
    # If it fails to load (missing weights, OOM, gated model on a fresh box), heed keeps working
    # in transcription-only mode instead of hard-failing. "who said what" degrades to plain text.
    print(f"[heed] Loading pyannote on {devices['pyannote']}...", flush=True)
    t = time.time()
    try:
        import torch
        from pyannote.audio import Pipeline
        diarize_pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")
        pyannote_tuning = pick_pyannote_tuning(devices)
        if devices["pyannote"] in ("cuda", "mps"):
            diarize_pipeline.to(torch.device(devices["pyannote"]))
        else:
            cpu_threads = int(pyannote_tuning.get("cpu_threads", 0) or 0)
            if cpu_threads > 0:
                try:
                    torch.set_num_threads(cpu_threads)
                    torch.set_num_interop_threads(max(1, cpu_threads // 2))
                    print(f"[heed] Pyannote CPU threads tuned: {cpu_threads}", flush=True)
                except Exception as e:
                    print(f"[heed] Could not tune pyannote CPU threads: {e}", flush=True)

        bs = int(pyannote_tuning.get("batch_size", 8) or 8)
        try:
            diarize_pipeline._segmentation.batch_size = bs
            if hasattr(diarize_pipeline, '_embedding'):
                diarize_pipeline._embedding.batch_size = bs
        except Exception as e:
            print(f"[heed] Could not apply pyannote batch_size={bs}: {e}", flush=True)

        pyannote_runtime_info = {
            "model": "pyannote/speaker-diarization-3.1",
            "device": pyannote_tuning.get("device", devices["pyannote"]),
            "profile": pyannote_tuning.get("profile", "balanced"),
            "batch_size": bs,
            "reason": pyannote_tuning.get("reason", "auto"),
            **({"cpu_threads": pyannote_tuning.get("cpu_threads")} if pyannote_tuning.get("cpu_threads") else {}),
        }
        models_ready["pyannote"] = True
        diarize_backend = "pyannote"
        print(f"[heed] Pyannote ready in {time.time()-t:.1f}s ({devices['pyannote']})", flush=True)
    except Exception as e:
        diarize_pipeline = None
        models_ready["pyannote"] = False
        pyannote_runtime_info = {"model": None, "disabled": True, "reason": f"load failed: {str(e)[:120]}"}
        print(f"[heed] Pyannote unavailable ({str(e)[:100]}) — running TRANSCRIPTION-ONLY (no diarization)", flush=True)

    print(f"[heed] All models ready! (whisper={'ok' if models_ready['whisper'] else 'FAIL'}, "
          f"diarization={'on' if models_ready['pyannote'] else 'off'})", flush=True)


# --- Transcription (faster-whisper) ---
# Shared faster-whisper decode policy — defined in ONE place (high cohesion) so every
# transcribe() call (final + live + dual mic/sys channels) behaves identically.
# condition_on_previous_text=False stops repetition cascades (the "y y y..." loops) without
# touching real speech. NOTE: vad_filter was tried and REMOVED — on quiet mic audio Silero VAD
# chopped out real words ("uno dos tres probando..." → "dos, ando, hit"). The empty/garbage
# sessions were NOT a Whisper-params problem; root cause is the process-stream crash (libavdevice).
WHISPER_OPTS = {
    "condition_on_previous_text": False,
}


def is_degenerate_repetition(text):
    """Detect Whisper repetition-loop hallucinations.

    Covers single-token loops ('ya ya ya ya...', 'y y y') AND short-cycle loops
    ('o elementos o elementos o elementos...'). Heuristic: a real sentence has diverse
    words, so if a chunk of >=6 words has a very LOW unique-token ratio (<0.35) it's a
    degenerate loop, not speech. The accurate final pass re-transcribes regardless.
    """
    words = text.split()
    if len(words) < 6:
        return False
    return len(set(words)) / len(words) < 0.35


def transcribe(wav_path, language="auto", srt_output=None):
    lang = None if language == "auto" else language
    # Lock: whisper model is not thread-safe — serialize access.
    with whisper_lock:
        segments_gen, info = whisper_model.transcribe(wav_path, language=lang, **WHISPER_OPTS)
        # MUST consume the generator inside the lock (it holds model state)
        segments_list = list(segments_gen)

    srt_lines = []
    plain_lines = []
    for idx, seg in enumerate(segments_list, 1):
        start_ts = format_ts(seg.start)
        end_ts = format_ts(seg.end)
        text = seg.text.strip()
        srt_lines.append(f"{idx}\n{start_ts} --> {end_ts}\n{text}\n")
        plain_lines.append(text)

    srt_content = "\n".join(srt_lines)
    text = "\n".join(plain_lines) if plain_lines else ""

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
        "language": info.language if info else language,
        "model": whisper_model_name,
    }


def _language_support():
    """What the UI should offer for the ACTIVE engine: the supported codes (None = all
    Whisper langs the client already lists) and whether language auto-detection works."""
    import engines
    codes, supports_auto = engines.supported_languages(active_engine)
    return {"engine": active_engine, "codes": codes, "supports_auto": supports_auto}


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
def _diarize_parakeet(wav_path, srt_path=None):
    """Diarization via the FluidAudio sidecar (Apple Silicon, no gated token).
    Returns the SAME contract as the pyannote path so callers don't branch.
    Note: cross-session voice naming (embeddings/match_voice) is pyannote-only for now;
    here speakers are stable per-session labels ("Speaker N") mapped from FluidAudio IDs."""
    import engines
    raw_segments = engines.get_parakeet().diarize(wav_path)  # [{speaker, start, end}, ...]

    # Map FluidAudio speaker ids -> "Speaker 1/2/..." in first-appearance order.
    speakers_map = {}
    counter = 0
    diar_segments = []
    for seg in raw_segments:
        sid = str(seg.get("speaker", "?"))
        if sid not in speakers_map:
            counter += 1
            speakers_map[sid] = f"Speaker {counter}"
        diar_segments.append({
            "start": round(float(seg.get("start", 0.0)), 2),
            "end": round(float(seg.get("end", 0.0)), 2),
            "speaker": speakers_map[sid],
        })
    diar_segments.sort(key=lambda s: s["start"])

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
        "embeddings": {},  # FluidAudio embeddings not exposed yet → no cross-session match
    }


def diarize(wav_path, srt_path=None, min_speakers=None, max_speakers=None):
    if diarize_backend == "parakeet":
        return _diarize_parakeet(wav_path, srt_path)
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
        best_speaker = None
        best_overlap = 0
        for d in diar_segs:
            ov = max(0, min(seg["end"], d["end"]) - max(seg["start"], d["start"]))
            if ov > best_overlap:
                best_overlap = ov
                best_speaker = d["speaker"]
        # Fallback 1: midpoint inside a diarization segment
        if not best_speaker:
            for d in diar_segs:
                if d["start"] <= mid <= d["end"]:
                    best_speaker = d["speaker"]
                    break
        # Fallback 2: nearest diarization segment by time distance.
        # Eliminates "Speaker ?" — pyannote had a small gap but someone WAS talking.
        if not best_speaker and diar_segs:
            nearest = min(diar_segs, key=lambda d: min(abs(d["start"] - mid), abs(d["end"] - mid)))
            best_speaker = nearest["speaker"]
        result.append({"speaker": best_speaker or "Speaker ?", "start": seg["start"], "end": seg["end"], "text": seg["text"]})
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
#
# PERFORMANCE ARCHITECTURE (optimized):
#
#   split_stereo ──┬──► mic.wav ──► whisper(mic) ──► "Me" segments     ← CPU
#                  │                                                     (sequential,
#                  └──► sys.wav ──► whisper(sys) ──► sys SRT             whisper not
#                         │                            │                 thread-safe)
#                         │                            ▼
#                         └──► pyannote(sys) ─────► assign_speakers     ← GPU
#                              (PARALLEL with           │                (runs at the
#                               whisper above)          ▼                same time as
#                                                  sys segments          whisper!)
#
#   Total time ≈ max(whisper_mic + whisper_sys, pyannote_sys) instead of
#                    whisper_mic + whisper_sys + pyannote_sys
#
#   On a GTX 1650: pyannote ~5s GPU, whisper ~10s CPU × 2 = ~20s
#   Old: 20 + 5 = 25s.  New: max(20, 5) = 20s.  Saves ~5s.
#   On bigger recordings: pyannote scales to 15-25s, savings grow to 10-20s.

def split_stereo(wav_path):
    """Split a stereo WAV into two mono WAVs in ONE ffmpeg call (reads input once).
    Returns (mic_path, sys_path, mic_has_audio, sys_has_audio)."""
    base = wav_path.rsplit(".", 1)[0]
    mic_path = f"{base}-mic.wav"
    sys_path = f"{base}-sys.wav"
    # Single ffmpeg call: split + volumedetect on both channels simultaneously.
    # Reads the input WAV once, writes two outputs + prints volume stats to stderr.
    proc = subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "info",
            "-i", wav_path,
            "-filter_complex",
            "[0:a]pan=mono|c0=c0,volumedetect[micout];"
            "[0:a]pan=mono|c0=c1,volumedetect[sysout]",
            "-map", "[micout]", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", mic_path,
            "-map", "[sysout]", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", sys_path,
        ],
        capture_output=True, text=True,
    )
    # Parse per-channel volume from stderr to detect silent channels.
    # CRITICAL: volumedetect prints its summary at filter-CLOSE time, and that order is
    # NOT the filtergraph order (it routinely comes out reversed). So we must NOT assume
    # the first "mean_volume" line is the mic — doing that swapped mic/sys and made heed
    # skip the channel that actually had speech (empty transcripts). Each line is tagged
    # [Parsed_volumedetect_N]; micout is declared before sysout, so it always gets the
    # LOWER N. We map by N, not by print order. (Cross-platform bug — affects Linux too.)
    SILENCE_DB = -50.0
    mic_has = True
    sys_has = True
    measured = {}  # filter_index -> mean dB
    for line in proc.stderr.split("\n"):
        m = re.search(r"Parsed_volumedetect_(\d+).*mean_volume:\s*(-?[\d.]+)", line)
        if m:
            measured[int(m.group(1))] = float(m.group(2))
    if measured:
        order = sorted(measured)  # ascending filter index → [mic_idx, sys_idx]
        mic_has = measured[order[0]] > SILENCE_DB
        if len(order) > 1:
            sys_has = measured[order[1]] > SILENCE_DB

    return mic_path, sys_path, mic_has, sys_has


# process_dual was removed — replaced by _stream_dual in the Handler class
# and /api/finalize in the Bun server. The live transcription pipeline handles
# all dual-channel processing now.


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
            self._json({
                "ready": all(models_ready.values()),
                **models_ready,
                "whisper_info": whisper_runtime_info,
                "pyannote_info": pyannote_runtime_info,
                "live_tuning": live_tuning,
                "languages": _language_support(),
            })
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

        elif self.path == "/transcribe-live":
            # Live transcription using the auto-picked live model.
            if not whisper_model_live:
                self._json({"error": "live whisper not loaded"}, 503)
                return
            # Quick RMS energy check: skip whisper entirely for silent chunks.
            # Saves 3-9 seconds per silent chunk (whisper wastes time on silence).
            try:
                import wave as _wave, struct as _struct, math as _math
                with _wave.open(body["wav_path"]) as _wf:
                    _frames = _wf.readframes(min(_wf.getnframes(), 48000))  # first 3s max
                    _samples = _struct.unpack('<' + 'h' * (len(_frames) // 2), _frames)
                    _rms = _math.sqrt(sum(s*s for s in _samples) / max(len(_samples), 1))
                if _rms < 300:
                    self._json({"text": "", "language": "auto", "time_ms": 0, "skipped": "silence"})
                    return
            except Exception:
                pass  # if check fails, proceed with whisper
            t = time.time()
            lang = body.get("language", "auto")
            lang = None if lang == "auto" else lang
            with whisper_live_lock:
                segments_gen, info = whisper_model_live.transcribe(body["wav_path"], language=lang, **WHISPER_OPTS)
                segments_list = list(segments_gen)
            lines = []
            for seg in segments_list:
                text = seg.text.strip()
                if text and not is_degenerate_repetition(text):
                    lines.append(text)
            process_s = time.time() - t

            # RuntimeGovernor: observe how long THIS chunk took vs its audio length, and
            # self-correct — hot-swap to a lighter live model if we're falling behind under
            # contention, or recover toward the ceiling when there's headroom.
            gov_info = {}
            if live_governor is not None:
                audio_s = float(body.get("audio_s", 3.0)) or 3.0
                dec = live_governor.observe(audio_s, process_s)
                if dec.changed and dec.live_model != whisper_model_live_name:
                    _swap_live_model(dec.live_model)
                gov_info = {"live_model": whisper_model_live_name, "interval_ms": dec.interval_ms,
                            "changed": dec.changed, "reason": dec.reason}

            self._json({
                "text": " ".join(lines),
                "language": info.language if info else "auto",
                "model": whisper_model_live_name,
                "time_ms": int(process_s * 1000),
                "gov": gov_info,
            })

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

        elif self.path == "/process-stream":
            # Streaming version: emits SSE events as whisper produces segments.
            # Frontend sees text from second 1 instead of waiting for the full pipeline.
            if not models_ready["whisper"] or not models_ready["pyannote"]:
                self._json({"error": "models not ready"}, 503)
                return

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            def sse(event, data):
                self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
                self.wfile.flush()

            try:
                t_start = time.time()
                wav_path = body["wav_path"]
                language = body.get("language", "auto")
                is_dual = body.get("dual_channel", False)

                if is_dual:
                    self._stream_dual(sse, wav_path, language, body.get("min_speakers"), body.get("max_speakers"))
                else:
                    # Non-dual: process_full and emit result at end
                    result = process_full(wav_path, language, body.get("diarize", False), body.get("min_speakers"), body.get("max_speakers"))
                    tx = result.get("transcribe", {})
                    diar = result.get("diarize", {})
                    for seg in diar.get("segments", []):
                        sse("segment", seg)
                    sse("speakers", {"speakers": diar.get("speakers", []), "embeddings": diar.get("embeddings", {})})
                    sse("done", {
                        "text": tx.get("text", ""),
                        "language": tx.get("language", language),
                        "model": tx.get("model", whisper_model_name),
                        "srt_path": tx.get("srt_path", ""),
                        "txt_path": tx.get("txt_path", ""),
                    })

                sse("complete", {"total_time_ms": int((time.time() - t_start) * 1000)})
            except Exception as e:
                sse("error", {"message": str(e)})

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

    def _stream_dual(self, sse, wav_path, language, min_speakers, max_speakers):
        """Stream dual-channel processing with progressive segment emission."""
        mic_path, sys_path, mic_has, sys_has = split_stereo(wav_path)

        # Launch pyannote on GPU immediately (parallel with whisper)
        pyannote_future = None
        if sys_has:
            pyannote_future = ThreadPoolExecutor(max_workers=1).submit(
                diarize, sys_path, None, min_speakers, max_speakers
            )

        sse("phase", {"phase": "transcribing", "channel": "mic"})

        # Stream mic segments as they come from faster-whisper
        lang = None if language == "auto" else language
        mic_srt_lines = []
        mic_segments_raw = []
        mic_info = None
        if mic_has:
            segments_gen, mic_info = whisper_model.transcribe(mic_path, language=lang, **WHISPER_OPTS)
            for idx, seg in enumerate(segments_gen, 1):
                text = seg.text.strip()
                if not text or is_degenerate_repetition(text):
                    continue
                segment_data = {
                    "speaker": "Me",
                    "start": round(seg.start, 2),
                    "end": round(seg.end, 2),
                    "text": text,
                    "channel": "mic",
                }
                sse("segment", segment_data)
                mic_srt_lines.append(f"{idx}\n{format_ts(seg.start)} --> {format_ts(seg.end)}\n{text}\n")
                mic_segments_raw.append(segment_data)

        sse("phase", {"phase": "transcribing", "channel": "sys"})

        # Stream sys segments (speaker = "???" until pyannote finishes)
        sys_srt_lines = []
        sys_raw_segs = []
        sys_info = None
        if sys_has:
            segments_gen, sys_info = whisper_model.transcribe(sys_path, language=lang, **WHISPER_OPTS)
            for idx, seg in enumerate(segments_gen, 1):
                text = seg.text.strip()
                if not text or is_degenerate_repetition(text):
                    continue
                segment_data = {
                    "speaker": "???",
                    "start": round(seg.start, 2),
                    "end": round(seg.end, 2),
                    "text": text,
                    "channel": "sys",
                }
                sse("segment", segment_data)
                sys_srt_lines.append(f"{idx}\n{format_ts(seg.start)} --> {format_ts(seg.end)}\n{text}\n")
                sys_raw_segs.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text})

        # Write SRT files
        mic_srt_path = mic_path + ".srt"
        with open(mic_srt_path, "w") as f:
            f.write("\n".join(mic_srt_lines))
        sys_srt_path = sys_path + ".srt"
        with open(sys_srt_path, "w") as f:
            f.write("\n".join(sys_srt_lines))

        # Wait for pyannote (been running on GPU this whole time)
        sse("phase", {"phase": "identifying_speakers"})

        speakers_list = []
        embeddings = {}
        final_sys_segments = []
        if pyannote_future:
            try:
                raw_diar = pyannote_future.result(timeout=300)
                diar_segs = raw_diar.get("segments", [])
                speakers_list = raw_diar.get("speakers", [])
                embeddings = raw_diar.get("embeddings", {})
                if sys_raw_segs and diar_segs:
                    merged = assign_speakers(diar_segs, sys_raw_segs)
                    for s in merged:
                        final_sys_segments.append({
                            "speaker": s["speaker"],
                            "start": s["start"],
                            "end": s["end"],
                            "text": s.get("text", ""),
                            "channel": "sys",
                        })
            except Exception as e:
                print(f"[heed] stream diarize failed: {e}", flush=True)

        if sys_has and not final_sys_segments and sys_raw_segs:
            for s in sys_raw_segs:
                final_sys_segments.append({
                    "speaker": "Speaker 1", "start": s["start"],
                    "end": s["end"], "text": s["text"], "channel": "sys",
                })
            speakers_list = ["Speaker 1"]

        all_speakers = []
        if mic_segments_raw:
            all_speakers.append("Me")
        all_speakers.extend(speakers_list)
        seen = set()
        all_speakers = [s for s in all_speakers if not (s in seen or seen.add(s))]
        all_segments = sorted(mic_segments_raw + final_sys_segments, key=lambda s: s["start"])

        sse("speakers", {
            "speakers": all_speakers,
            "segments": all_segments,
            "embeddings": embeddings,
        })

        plain_text = "\n".join(seg["text"] for seg in all_segments if seg.get("text"))
        detected_lang = language
        if mic_has and mic_info:
            detected_lang = mic_info.language
        elif sys_has and sys_info:
            detected_lang = sys_info.language
        sse("done", {
            "text": plain_text,
            "language": detected_lang,
            "model": whisper_model_name,
            "srt_path": sys_srt_path or mic_srt_path,
            "txt_path": "",
            "files": {"wav": wav_path, "srt": sys_srt_path or mic_srt_path, "txt": ""},
        })


if __name__ == "__main__":
    # Load models in background
    loader = threading.Thread(target=load_models, daemon=True)
    loader.start()

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[heed] Transcription server on :{PORT}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()

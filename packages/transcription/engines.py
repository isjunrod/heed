"""Transcription engine abstraction — pick the FASTEST backend per hardware/OS.

  Apple Silicon  → MLX-Whisper        (Apple GPU via Metal; ~5x faster than CTranslate2-on-CPU)
  NVIDIA (CUDA)  → faster-whisper      (CTranslate2 on CUDA, float16)
  CPU-only       → faster-whisper      (CTranslate2 on CPU, int8)

Every adapter exposes the SAME interface as faster-whisper:
    transcribe(wav_path, language=None, **opts) -> (segments_iterable, info)
where each segment has .start/.end/.text and info has .language. This keeps the
rest of heed (live + final + dual-channel) unchanged — pure low-coupling swap.

Linux/Windows note: mlx is only importable on Apple Silicon, so the MLX path is
never selected elsewhere — the CUDA/CPU path (current behavior) is untouched.
"""
import sys
import platform
import os
import json
import wave
import subprocess
import threading


class _Seg:
    """Lightweight stand-in for faster-whisper's Segment (only fields heed uses)."""
    __slots__ = ("start", "end", "text")

    def __init__(self, start, end, text):
        self.start = start
        self.end = end
        self.text = text


class _Info:
    __slots__ = ("language",)

    def __init__(self, language):
        self.language = language


# Parakeet TDT v3 (FluidAudio) transcribes these 28 European languages and NO others —
# anything else silently falls back to English, so the UI must only offer these on Apple
# Silicon. Mirrors FluidAudio's `enum Language` (Shared/TokenLanguageFilter.swift).
# Parakeet has NO language auto-detection: without an explicit language it assumes English.
PARAKEET_LANGUAGES = [
    "en", "es", "fr", "de", "it", "pt", "ro", "nl", "da", "sv", "fi", "hu", "et", "lv",
    "lt", "mt", "pl", "cs", "sk", "sl", "hr", "bs", "ru", "uk", "be", "bg", "sr", "el",
]


def supported_languages(engine_kind):
    """Return (codes, supports_auto) for the active engine.
    Parakeet → its 28 langs, no auto-detect. Whisper (mlx/ctranslate2) → None (all) + auto."""
    if engine_kind == "parakeet":
        return PARAKEET_LANGUAGES, False
    return None, True  # None = the full Whisper list the client already has


def is_apple_silicon():
    return sys.platform == "darwin" and platform.machine() == "arm64"


def mlx_available():
    """True only on Apple Silicon WITH mlx-whisper installed."""
    if not is_apple_silicon():
        return False
    try:
        import mlx_whisper  # noqa: F401
        return True
    except Exception:
        return False


# Logical model name -> mlx-community HF repo (public, no token).
_MLX_REPOS = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    # 4-bit large-v3: measured same accuracy as fp16 but ~1.5x faster and ~1/3 the memory
    # on Apple Silicon — lets more machines afford the most accurate tier.
    "large-v3": "mlx-community/whisper-large-v3-mlx-4bit",
}

# faster-whisper-specific kwargs that mlx_whisper.transcribe does not accept.
_MLX_DROP = {"vad_filter", "vad_parameters", "beam_size", "best_of", "compute_type", "device"}


class CTranslate2Engine:
    """faster-whisper (CTranslate2): excellent on CPU and NVIDIA/CUDA."""

    kind = "ctranslate2"

    def __init__(self, model_name, device="cpu", compute_type="int8"):
        from faster_whisper import WhisperModel
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.model = WhisperModel(model_name, device=device, compute_type=compute_type)

    def transcribe(self, wav_path, language=None, **opts):
        # Already returns (generator, info) with .start/.end/.text and info.language.
        return self.model.transcribe(wav_path, language=language, **opts)


class MLXEngine:
    """mlx-whisper: runs Whisper on the Apple GPU (Metal) using unified memory."""

    kind = "mlx"

    def __init__(self, model_name):
        import mlx_whisper
        self._mlx = mlx_whisper
        self.model_name = model_name
        self.repo = _MLX_REPOS.get(model_name, _MLX_REPOS["small"])

    def transcribe(self, wav_path, language=None, **opts):
        kwargs = {k: v for k, v in opts.items() if k not in _MLX_DROP}
        r = self._mlx.transcribe(wav_path, path_or_hf_repo=self.repo, language=language, **kwargs)
        segs = [
            _Seg(s.get("start", 0.0), s.get("end", 0.0), s.get("text", ""))
            for s in r.get("segments", [])
        ]
        return iter(segs), _Info(r.get("language", language))


# --- Parakeet / FluidAudio sidecar (Apple Silicon only) ---------------------------------
# A resident Swift process (packages/transcription/native/heed-parakeet) runs Parakeet ASR on
# the Apple Neural Engine — far faster than Whisper. heed talks to it over newline-delimited
# JSON on stdin/stdout. Only used when its binary has been built (Apple Silicon).
_SIDECAR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "native", "heed-parakeet")
_SIDECAR_BIN = os.path.join(_SIDECAR_DIR, ".build", "release", "heed-parakeet")
_parakeet_singleton = None
_parakeet_lock = threading.Lock()


def parakeet_available():
    """True on Apple Silicon when the sidecar binary has been built."""
    return is_apple_silicon() and os.path.exists(_SIDECAR_BIN)


def _wav_duration(path):
    try:
        with wave.open(path) as w:
            return w.getnframes() / float(w.getframerate() or 16000)
    except Exception:
        return 0.0


class ParakeetEngine:
    """Talks to the resident Swift sidecar. One model for all languages/tiers, so `model_name`
    is ignored. Same interface as the Whisper engines: transcribe() -> (segments_iter, info)."""

    kind = "parakeet"

    def __init__(self):
        self.proc = subprocess.Popen(
            [_SIDECAR_BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        self.lock = threading.Lock()
        self.proc.stdout.readline()  # consume the {"ready":...} line

    def _request(self, obj, timeout_lines=200):
        with self.lock:
            self.proc.stdin.write(json.dumps(obj) + "\n")
            self.proc.stdin.flush()
            # CoreML/ANE can print noisy "E5RT ..." lines to STDOUT during model load/inference,
            # polluting the JSON protocol. Be robust: skip non-JSON lines and parse from the first
            # "{" on a line (the E5RT text has no brace and gets prepended to the response line).
            for _ in range(timeout_lines):
                line = self.proc.stdout.readline()
                if not line:
                    return {"ok": False, "error": "sidecar closed"}
                i = line.find("{")
                if i < 0:
                    continue
                try:
                    return json.loads(line[i:])
                except Exception:
                    continue
            return {"ok": False, "error": "bad sidecar response"}

    def transcribe(self, wav_path, language=None, **opts):
        lang = language if language else "auto"
        r = self._request({"cmd": "transcribe", "wav": wav_path, "language": lang})
        text = (r.get("text", "") if r.get("ok") else "").strip()
        segs = [_Seg(0.0, _wav_duration(wav_path), text)] if text else []
        return iter(segs), _Info(language or "auto")

    def diarize(self, wav_path):
        """Speaker segments via FluidAudio CoreML (no gated token). Apple Silicon only."""
        r = self._request({"cmd": "diarize", "wav": wav_path})
        return r.get("segments", []) if r.get("ok") else []

    # --- Live streaming (Nemotron multilingual): real-time commit/partial ---
    def stream_start(self, language=None):
        """Open/reset a streaming session. First call downloads+loads the model (slow)."""
        return self._request({"cmd": "stream-start", "language": language or "en"}).get("ok", False)

    def stream_feed(self, wav_path):
        """Append the NEW audio segment; returns the growing partial transcript (stable prefix)."""
        r = self._request({"cmd": "stream-feed", "wav": wav_path})
        return r.get("partial", "") if r.get("ok") else ""

    def stream_finish(self):
        """End the stream → final text (== what was on screen)."""
        r = self._request({"cmd": "stream-finish"})
        return r.get("text", "") if r.get("ok") else ""


def get_parakeet():
    """Lazy shared sidecar (one process for live + final)."""
    global _parakeet_singleton
    with _parakeet_lock:
        if _parakeet_singleton is None:
            _parakeet_singleton = ParakeetEngine()
        return _parakeet_singleton


def select_engine_kind(device_cfg=None):
    """Apple Silicon with the Parakeet sidecar built → 'parakeet'; else mlx; else ctranslate2."""
    if parakeet_available():
        return "parakeet"
    if mlx_available():
        return "mlx"
    return "ctranslate2"


def make_engine(model_name, device_cfg):
    """Build the fastest engine for this machine running `model_name`."""
    kind = select_engine_kind(device_cfg)
    if kind == "parakeet":
        return get_parakeet()  # shared singleton; model_name ignored (Parakeet is one model)
    if kind == "mlx":
        return MLXEngine(model_name)
    device = device_cfg.get("whisper", "cpu")
    compute_type = "float16" if device == "cuda" else "int8"
    return CTranslate2Engine(model_name, device=device, compute_type=compute_type)

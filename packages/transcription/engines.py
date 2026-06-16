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


def select_engine_kind(device_cfg=None):
    """Apple Silicon (with mlx) → 'mlx'; otherwise → 'ctranslate2' (CUDA or CPU)."""
    if mlx_available():
        return "mlx"
    return "ctranslate2"


def make_engine(model_name, device_cfg):
    """Build the fastest engine for this machine running `model_name`."""
    if select_engine_kind(device_cfg) == "mlx":
        return MLXEngine(model_name)
    device = device_cfg.get("whisper", "cpu")
    compute_type = "float16" if device == "cuda" else "int8"
    return CTranslate2Engine(model_name, device=device, compute_type=compute_type)

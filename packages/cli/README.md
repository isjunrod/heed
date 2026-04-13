# create-heed

One-command installer for [heed](https://github.com/isjunrod/heed) — local-first meeting transcription with real speaker diarization.

Your audio never leaves your machine. Ever.

## Install

```bash
npx create-heed
```

The installer detects your OS, checks dependencies (Bun, Python, ffmpeg, Ollama), and walks you through each step.

## Update

```bash
npx create-heed update
```

Only downloads what changed. Auto-reinstalls dependencies if needed.

## What is heed?

Self-hosted meeting transcription that works on top of Zoom, Meet, Teams, Discord — without anyone knowing.

- **100% local** — Whisper, pyannote, and Ollama run on your machine. No API keys. No subscriptions.
- **Real speaker diarization** — Identifies people by how they sound, not by login name.
- **Voice memory** — Rename a speaker once, heed remembers their voice forever.
- **Channel-based overlap detection** — Detects when two people speak at once.
- **Hardware-aware** — Auto-picks the best AI model for your GPU/CPU.

Linux + macOS. Open source. MIT license.

[GitHub](https://github.com/isjunrod/heed) | [Report issues](https://github.com/isjunrod/heed/issues)

<p align="center">
  <img src="https://img.shields.io/badge/100%25-Local-10B981?style=for-the-badge" alt="100% Local" />
  <img src="https://img.shields.io/badge/Open_Source-MIT-2563EB?style=for-the-badge" alt="MIT License" />
  <img src="https://img.shields.io/badge/Linux_%2B_macOS-supported-F59E0B?style=for-the-badge" alt="Linux + macOS" />
</p>

<p align="center">
  <img src="assets/logo.svg" alt="heed" width="64" height="64" />
</p>

<p align="center">
  <strong>Every voice, even when they speak at once.</strong><br/>
  <em>Local. Open. Yours.</em>
</p>

<p align="center">
  Self-hosted meeting transcription with real speaker diarization.<br/>
  Runs on top of Zoom, Meet, Teams, Discord — without anyone knowing.<br/>
  Your audio never leaves your machine. Ever.
</p>

---

<p align="center">
  <img src="assets/demo.gif" alt="heed demo — record, live transcription, AI notes, session tags" width="100%" />
</p>

> *4 speakers. Identified by voice, not by login. Live transcription while recording. AI notes with one click. Everything processed by YOUR GPU. $0/month.*

---

## Why heed exists

Your meeting audio is personal. It contains strategy discussions, salary negotiations, client calls, medical appointments. Today, every meeting tool sends that audio to someone else's servers.

**Granola** charges $40/month and only works on macOS. **Otter** and **Fireflies** send your audio to the cloud. **Meetily** promised open-source local transcription but [doesn't compile on most Linux distros](https://github.com/meetily/meetily/issues). **Fathom** is macOS-only and cloud-dependent.

heed is different:

- **Your audio stays on your disk.** Whisper, pyannote, and Ollama run on your machine. No API keys. No subscriptions. No data leaving your network.
- **Works with everything.** Zoom, Google Meet, Teams, Discord, a YouTube video — if it plays on your computer, heed captures it. Nobody in the call needs to install anything.
- **Real speaker diarization.** Not "Speaker 1, Speaker 2" assigned by login. Actual voice analysis that identifies people by how they sound — and remembers them next time.

---

## How it's different

<table>
<tr>
<th></th>
<th align="center"><strong>heed</strong></th>
<th align="center">Granola</th>
<th align="center">Otter.ai</th>
<th align="center">Fathom</th>
<th align="center">Others</th>
</tr>
<tr>
<td><strong>100% local processing</strong></td>
<td align="center">Yes</td>
<td align="center">No (cloud AI)</td>
<td align="center">No (full SaaS)</td>
<td align="center">No (cloud)</td>
<td align="center">No (cloud)</td>
</tr>
<tr>
<td><strong>Linux support</strong></td>
<td align="center"><strong>Native</strong></td>
<td align="center">No</td>
<td align="center">Web only</td>
<td align="center">No</td>
<td align="center">Web only</td>
</tr>
<tr>
<td><strong>macOS support</strong></td>
<td align="center">Yes</td>
<td align="center">Yes</td>
<td align="center">Web</td>
<td align="center">Yes</td>
<td align="center">Web</td>
</tr>
<tr>
<td><strong>Voice-based diarization</strong></td>
<td align="center"><strong>pyannote 3.1</strong></td>
<td align="center">Basic</td>
<td align="center">Cloud model</td>
<td align="center">Cloud model</td>
<td align="center">By login name</td>
</tr>
<tr>
<td><strong>Voice memory</strong></td>
<td align="center"><strong>Yes</strong></td>
<td align="center">No</td>
<td align="center">No</td>
<td align="center">No</td>
<td align="center">No</td>
</tr>
<tr>
<td><strong>Overlap detection</strong></td>
<td align="center"><strong>Channel-based</strong></td>
<td align="center">No</td>
<td align="center">No</td>
<td align="center">No</td>
<td align="center">No</td>
</tr>
<tr>
<td><strong>Works with Zoom/Meet/Teams</strong></td>
<td align="center">Yes</td>
<td align="center">Yes</td>
<td align="center">Bot joins</td>
<td align="center">Yes</td>
<td align="center">Must use their platform</td>
</tr>
<tr>
<td><strong>Offline capable</strong></td>
<td align="center"><strong>Yes</strong></td>
<td align="center">No</td>
<td align="center">No</td>
<td align="center">No</td>
<td align="center">No</td>
</tr>
<tr>
<td><strong>Open source</strong></td>
<td align="center"><strong>MIT</strong></td>
<td align="center">No</td>
<td align="center">No</td>
<td align="center">No</td>
<td align="center">Partial</td>
</tr>
<tr>
<td><strong>Price</strong></td>
<td align="center"><strong>$0</strong></td>
<td align="center">$40/mo</td>
<td align="center">$17/mo</td>
<td align="center">$32/mo</td>
<td align="center">Free (broken)</td>
</tr>
</table>

---

## Install

One command. It detects your OS, checks dependencies, and installs everything:

```bash
npx create-heed
```

The installer walks you through each step:

```
  heed — local-first meeting transcription

> Detected: Linux (AMD Ryzen 5 5600X)

[1/7] Bun runtime
✓ Bun 1.3.11 already installed

[2/7] Python 3.10+
✓ Python 3.12.3 found

[3/7] AI models (faster-whisper + pyannote)
! Installing AI packages (~3GB download first time)
? Install faster-whisper + pyannote-audio + torch? (Y/n) y
✓ AI packages installed

[4/7] ffmpeg (audio capture)
✓ ffmpeg already installed

[5/7] Ollama (local AI engine)
✓ Ollama 0.20.0 already installed

[6/7] Download heed
> Cloning from GitHub...
✓ Downloaded

[7/7] Launch heed
? Open as floating desktop panel? (Y/n)
```

### Manual install

```bash
git clone https://github.com/isjunrod/heed.git
cd heed
bun install
bun run dev
# Open http://localhost:5000
```

**Requirements:** Bun, Python 3.10+, ffmpeg, Ollama, and one of: PipeWire (Linux) or BlackHole (macOS) for system audio capture.

---

## Update

From anywhere:

```bash
npx create-heed update
```

Only downloads what changed. Auto-reinstalls dependencies if needed.

---

## How it works

```
Your mic ──┐
           ├── ffmpeg (stereo) ──► dual-capture.wav
System ────┘                              │
                                          ▼
                           Split L (mic) / R (system)
                                    │           │
                              Whisper(mic)  Whisper(sys)
                              label "Me"    + pyannote(sys)
                                    │           │
                                    └─► merge timelines
                                            │
                                    detect overlaps (≥300ms)
                                            │
                                    Speakers + AI Notes
```

**Channel-based diarization.** Mic and system audio are captured as separate stereo channels. Whisper transcribes each independently. pyannote runs speaker diarization only on the system channel (your mic is always you). Timelines are merged and overlaps are flagged when two people spoke simultaneously.

This is why heed detects overlapping voices that other tools miss — they mix everything to mono before processing, destroying the spatial information.

---

## Key features

**Live transcription** — Text appears in real-time as you record. You don't wait until the meeting ends to know what was said. Speakers are identified progressively while you're still talking.

**Overlap detection** — Two people talking at once? heed catches it. Because mic and system audio live in separate channels, it knows exactly when voices collide. Every other tool mixes to mono first and loses this information forever.

**Voice memory** — Rename a speaker once. heed saves their voice embedding and recognizes them automatically in every future meeting. No training, no setup. It just remembers.

**Hardware-aware model picker** — On first launch, heed reads your GPU, VRAM, CPU, and RAM. Then it recommends the best AI model that actually fits your machine. 14 models from Llama, Qwen, Gemma families. Download in-app, one click, no terminal needed.

**Smart auto-titles** — "Q3 Revenue Review with Sarah and Marcus" instead of "Meeting Apr 12, 2026". Ollama generates a real title from the transcript content, in whatever language was spoken.

**Note templates** — Choose a prompt template before generating notes: general summary, sales call, 1-on-1, retrospective, or write your own. Same transcript, different output depending on what you need.

<details>
<summary><strong>All features</strong></summary>

<br/>

- **Smart rename = merge** — Rename "Speaker 2" to "Sarah Chen". If she already exists, heed merges them automatically. No duplicates.
- **Inline `#tag` autocomplete** — Type `#` in the session title to organize by project, client, or topic.
- **Meeting auto-detector** — Detects Zoom, Meet, Teams, or Discord running and prompts you to record.
- **VRAM intelligence** — Forces Ollama to release GPU memory immediately after generating notes, so pyannote doesn't crash. Critical on 4GB GPUs.
- **Auto-recovery** — Crashed mid-recording? Audio is safe on disk. One click to recover on next launch.
- **GPU/CPU split** — Auto-detects free VRAM and splits work: <1.5GB → all CPU, 1.5-6GB → mixed, 6GB+ → all GPU. Zero config.
- **Offline capable** — No internet after setup. Record on a plane, transcribe on a train.
- **Works with everything** — Zoom, Meet, Teams, Discord, YouTube, podcasts. If it plays audio, heed captures it. Nobody knows.
- **Bilingual** — Setup wizard and in-app tour in English and Spanish. Auto-detected from your system.
- **GPU/CPU transparency** — If a model doesn't fit in VRAM, heed tells you why and offers CPU mode. No cryptic CUDA errors.
- **Ollama auto-retry** — Model crashed from RAM exhaustion? heed retries in 3 seconds automatically.

</details>

---

## Stack

```
packages/
├── client/         Vite + React 19 + TypeScript + Zustand + CSS Modules
├── server/         Bun (HTTP, SSE, ffmpeg orchestration, Ollama proxy)
├── transcription/  Python (faster-whisper + pyannote 3.1)
├── shared/types/   TypeScript interfaces (client ↔ server)
├── desktop/        Chrome --app launcher (floating panel)
└── cli/            npx create-heed installer
```

---

## Compatibility

| | Linux | macOS | Windows |
|---|---|---|---|
| **Status** | **Fully supported** | **Supported** | Coming soon |
| Audio capture | PipeWire | BlackHole + avfoundation | — |
| GPU acceleration | CUDA (NVIDIA) | MPS (Apple Silicon) | — |
| Desktop panel | Chrome --app | Chrome --app | — |

---

## Commands

```bash
bun run dev              # Start all services (server + client + python)
bun run build            # Build frontend for production
bun run desktop          # Open floating desktop panel
npx create-heed          # First-time install
npx create-heed update   # Update from anywhere
```

---

## Roadmap

- [ ] Real-time streaming transcription during recording (partial — live preview active)
- [ ] Export to Markdown / Obsidian / Notion
- [ ] Session search across all meetings
- [ ] Keyboard shortcut for global record toggle
- [ ] Weekly meeting digest via Ollama
- [ ] Google Calendar integration
- [ ] Windows support (WASAPI loopback)

---

## For Meetily users

If you're here because Meetily didn't compile on your Linux distro — welcome. heed was built specifically to fill that gap. No Electron. No broken deps. No cmake nightmares. Just `npx create-heed` and you're running in 2 minutes.

---

## Contributing

PRs welcome. The codebase is clean and typed. Start with `bun run dev` and explore the `packages/` structure.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.

---

## Acknowledgments

Inspired by [trx](https://github.com/crafter-station/trx) by CrafterStation.

---

<p align="center">
  <em>Built for the people who believe their conversations belong to them.</em>
</p>

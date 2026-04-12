import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { downloadFromUrl, normalizeAudio } from "./lib/media.ts";
const TRANSCRIPTION_SERVER = process.env.HEED_TRANSCRIPTION_URL || "http://127.0.0.1:5002";

const PORT = Number(process.env.PORT) || 5001;
const STATIC_ROOT = join(import.meta.dir, "..", "client", "dist");
const UPLOAD_DIR = join(tmpdir(), "heed-uploads");
const APP_DIR = join(homedir(), ".heed-app");
const SESSIONS_DIR = join(APP_DIR, "sessions");
const TEMPLATES_DIR = join(APP_DIR, "templates");
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
// Hard fallback only — actual model is read from ~/.heed-app/config.json (set by hardware
// auto-detection on first launch, or by the user via the model picker modal).
const FALLBACK_MODEL = process.env.HEED_MODEL || "llama3.2:1b";
const CONFIG_PATH = join(homedir(), ".heed-app", "config.json");

for (const dir of [UPLOAD_DIR, APP_DIR, SESSIONS_DIR, TEMPLATES_DIR]) {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// --- Persistent config (current model + GPU layer count) ---
// Note: this file may also contain legacy CLI fields (language, modelSize, etc.).
// We preserve those on write so we don't break the old CLI tool.
interface TrxConfig {
	ollama_model?: string;
	ollama_num_gpu?: number; // 0 = CPU-only, undefined = let Ollama decide, 999 = all layers on GPU
	[k: string]: unknown; // forward-compat for legacy keys
}

function loadConfig(): TrxConfig {
	if (existsSync(CONFIG_PATH)) {
		try {
			return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		} catch {}
	}
	return {};
}

function saveConfig(patch: Partial<TrxConfig>) {
	const merged = { ...loadConfig(), ...patch };
	writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
}

function getCurrentModel(): string {
	return loadConfig().ollama_model || FALLBACK_MODEL;
}

function getCurrentNumGpu(): number | undefined {
	return loadConfig().ollama_num_gpu;
}

// Auto-seed model selection on first run by asking Python what default fits this hardware.
// We seed if `ollama_model` is missing, even if other legacy keys exist in config.json.
async function seedConfigFromHardware() {
	if (loadConfig().ollama_model) return;
	try {
		const res = await fetch(`${TRANSCRIPTION_SERVER}/hardware`, { signal: AbortSignal.timeout(15000) });
		if (!res.ok) return;
		const hw = await res.json() as { default_model?: string; models?: Array<{ id: string; gpu_compatible: boolean }> };
		if (!hw.default_model) return;
		const def = hw.models?.find((m) => m.id === hw.default_model);
		saveConfig({
			ollama_model: hw.default_model,
			ollama_num_gpu: def?.gpu_compatible ? undefined : 0,
		});
		console.log(`[heed] First-run model: ${hw.default_model} (gpu=${def?.gpu_compatible ? "auto" : "off"})`);
	} catch (e) {
		console.log(`[heed] Could not seed model from hardware (Python not ready?): ${(e as Error).message}`);
	}
}
// Fire and forget — Python may still be loading models, retry once after a delay
seedConfigFromHardware();
setTimeout(() => { if (!loadConfig().ollama_model) seedConfigFromHardware(); }, 12000);

// --- Seed default templates on first run ---
const DEFAULT_TEMPLATES = [
	{
		id: "general",
		name: "General Meeting",
		description: "Universal meeting notes — works for any meeting",
		isDefault: true,
		prompt: `You are a meeting notes assistant. Generate structured meeting notes in this exact format:

## Summary
(2-3 sentences capturing the main topic)

## Key Points
- main discussion points

## Action Items
- [ ] task → owner

## Decisions Made
- decisions reached

Be concrete. Use the speakers' actual words when possible. Match the language of the transcript.`,
	},
	{
		id: "1on1",
		name: "1-on-1 Meeting",
		description: "Notes for one-on-one meetings between two people",
		isDefault: true,
		prompt: `You are a 1-on-1 meeting notes assistant. Generate structured notes in this exact format:

## Topics discussed
- main topics

## Updates / Status
- what each person reported

## Blockers
- challenges or blockers mentioned

## Action Items
- [ ] task → owner

## Follow-up for next 1-on-1
- items to revisit

Match the language of the transcript.`,
	},
	{
		id: "standup",
		name: "Daily Standup",
		description: "Notes for team daily standups",
		isDefault: true,
		prompt: `You are a standup notes assistant. Generate notes per person in this format:

## Team Updates

### [Person Name]
- **Yesterday:** what they did
- **Today:** what they will do
- **Blockers:** any blockers (or "none")

## Team Blockers
- shared blockers needing attention

## Action Items
- [ ] task → owner

Match the language of the transcript.`,
	},
	{
		id: "interview",
		name: "Interview",
		description: "Notes for candidate or research interviews",
		isDefault: true,
		prompt: `You are an interview notes assistant. Generate structured notes in this format:

## Candidate / Interviewee
(name and brief context if mentioned)

## Key Questions & Answers
**Q:** question
**A:** answer summary

(repeat for each significant Q&A)

## Strengths Observed
- positive points

## Concerns
- red flags or gaps

## Recommendation
(brief assessment)

Match the language of the transcript.`,
	},
	{
		id: "brainstorm",
		name: "Brainstorm",
		description: "Notes for ideation and brainstorm sessions",
		isDefault: true,
		prompt: `You are a brainstorm notes assistant. Generate notes in this format:

## Goal / Question
(what was being brainstormed)

## Ideas Generated
- group ideas by theme when possible

## Top Ideas
- the strongest ideas to pursue

## Open Questions
- questions left unanswered

## Next Steps
- [ ] what to do with these ideas

Match the language of the transcript.`,
	},
	{
		id: "customer",
		name: "Customer Call",
		description: "Notes for customer or sales calls",
		isDefault: true,
		prompt: `You are a customer call notes assistant. Generate notes in this format:

## Customer Info
(company, role if mentioned)

## Pain Points
- problems they raised

## Needs / Requirements
- what they're looking for

## Objections
- concerns or pushback

## Action Items
- [ ] follow-up task → owner

## Next Steps
(what was agreed for next interaction)

Match the language of the transcript.`,
	},
];

function seedTemplates() {
	for (const t of DEFAULT_TEMPLATES) {
		const filePath = join(TEMPLATES_DIR, `${t.id}.json`);
		if (!existsSync(filePath)) {
			writeFileSync(filePath, JSON.stringify(t, null, 2));
		}
	}
}
seedTemplates();

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".json": "application/json",
};

function serveStatic(path: string): Response | null {
	// Try the requested file
	let filePath = join(STATIC_ROOT, path === "/" ? "index.html" : path);

	// SPA fallback: any non-API, non-file path → index.html
	if (!existsSync(filePath) && !path.startsWith("/api") && !extname(path)) {
		filePath = join(STATIC_ROOT, "index.html");
	}

	if (!existsSync(filePath)) return null;

	const ext = extname(filePath);
	const isHtml = ext === ".html";

	return new Response(readFileSync(filePath), {
		headers: {
			"Content-Type": MIME[ext] || "application/octet-stream",
			// Disable caching of HTML so the user always gets the latest bundle reference
			"Cache-Control": isHtml ? "no-store, max-age=0" : "public, max-age=3600",
		},
	});
}

// --- Transcription (SSE) ---
async function handleTranscribe(req: Request): Promise<Response> {
	let input: string;
	let language = "auto";
	let diarize = true;
	let inputFilePath: string | null = null;

	const contentType = req.headers.get("content-type") || "";

	if (contentType.includes("multipart/form-data")) {
		const formData = await req.formData();
		const file = formData.get("file") as File | null;
		const url = formData.get("url") as string | null;
		language = (formData.get("language") as string) || "auto";
		diarize = formData.get("diarize") !== "false";

		if (file && file.size > 0) {
			const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
			inputFilePath = join(UPLOAD_DIR, `${Date.now()}-${safeName}`);
			const buffer = await file.arrayBuffer();
			writeFileSync(inputFilePath, Buffer.from(buffer));
			input = inputFilePath;
		} else if (url) {
			input = url;
		} else {
			return Response.json({ error: "No file or URL provided" }, { status: 400 });
		}
	} else {
		const body = await req.json();
		input = body.url || body.input;
		language = body.language || "auto";
		diarize = body.diarize || false;
		if (!input) return Response.json({ error: "No input provided" }, { status: 400 });
	}

	// For URLs, first download with yt-dlp then clean audio with ffmpeg
	let wavPath = input;
	const isUrl = /^https?:\/\//i.test(input);

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			let closed = false;
			const send = (event: string, data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					closed = true;
				}
			};
			try {
				// If URL, download with yt-dlp first
				if (isUrl) {
					send("step", { message: "Downloading media..." });
					const downloaded = await downloadFromUrl(input, UPLOAD_DIR);
					input = downloaded.filePath;
				}

				// Normalize audio (clean noise, mono 16kHz)
				send("step", { message: "Cleaning audio..." });
				if (!input.endsWith(".wav")) {
					wavPath = join(UPLOAD_DIR, `clean-${Date.now()}.wav`);
					await normalizeAudio(input, wavPath);
				} else {
					wavPath = input;
				}

				send("step", { message: "Transcribing with Whisper (GPU)..." });
				send("progress", { percent: 30 });

				// Detect dual-channel captures (L=mic, R=system) → enables overlap-aware diarization.
				const isDualChannel = /(?:^|\/)dual-capture-/.test(wavPath);

				// Call Python transcription server (auto-detect speaker count)
				const processBody: Record<string, unknown> = {
					wav_path: wavPath,
					language,
					diarize,
					dual_channel: isDualChannel,
				};

				const txRes = await fetch(`${TRANSCRIPTION_SERVER}/process`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(processBody),
				});

				if (!txRes.ok) {
					const err = await txRes.text();
					throw new Error(`Transcription server error: ${err}`);
				}

				const txData = await txRes.json() as any;
				send("progress", { percent: 100 });

				const txResult = txData.transcribe || {};
				const diarResult = txData.diarize || {};

				send("result", {
					success: true,
					text: txResult.text || "",
					files: {
						wav: wavPath,
						srt: txResult.srt_path || "",
						txt: txResult.txt_path || "",
					},
					metadata: { language: txResult.language || language, model: "small" },
					diarizedText: diarResult.text || "",
					speakers: diarResult.speakers || [],
					segments: diarResult.segments || [],
					wordCount: (txResult.text || "").split(/\s+/).filter(Boolean).length,
					timing: { total_ms: txData.total_time_ms },
				});
			} catch (e) {
				send("error", { message: (e as Error).message });
			} finally {
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
	});
}

// --- Templates CRUD ---
function loadTemplate(id: string): any | null {
	const filePath = join(TEMPLATES_DIR, `${id}.json`);
	if (!existsSync(filePath)) return null;
	try {
		return JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function handleListTemplates(): Response {
	const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"));
	const templates = files
		.map((f) => {
			try {
				return JSON.parse(readFileSync(join(TEMPLATES_DIR, f), "utf-8"));
			} catch {
				return null;
			}
		})
		.filter(Boolean)
		.sort((a: any, b: any) => {
			// Defaults first, then alpha
			if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
			return (a.name || "").localeCompare(b.name || "");
		});
	return Response.json(templates);
}

async function handleSaveTemplate(req: Request): Promise<Response> {
	const tpl = await req.json();
	if (!tpl.name || !tpl.prompt) {
		return Response.json({ error: "Template needs name and prompt" }, { status: 400 });
	}
	const id = tpl.id || `custom-${Date.now()}`;
	const data = { id, name: tpl.name, description: tpl.description || "", prompt: tpl.prompt, isDefault: false };
	writeFileSync(join(TEMPLATES_DIR, `${id}.json`), JSON.stringify(data, null, 2));
	return Response.json(data);
}

function handleDeleteTemplate(url: URL): Response {
	const id = url.searchParams.get("id");
	if (!id) return Response.json({ error: "No id" }, { status: 400 });
	const filePath = join(TEMPLATES_DIR, `${id}.json`);
	if (existsSync(filePath)) {
		const tpl = JSON.parse(readFileSync(filePath, "utf-8"));
		if (tpl.isDefault) {
			return Response.json({ error: "Cannot delete default template" }, { status: 400 });
		}
		unlinkSync(filePath);
	}
	return Response.json({ ok: true });
}

// --- Ollama summarization (SSE) ---
async function handleSummarize(req: Request): Promise<Response> {
	const { transcript, language, templateId, force_cpu } = await req.json();
	if (!transcript) return Response.json({ error: "No transcript provided" }, { status: 400 });

	// Load template (default to "general" if not specified)
	const template = loadTemplate(templateId || "general") || loadTemplate("general");

	let systemPrompt = template?.prompt;

	// Add language directive
	if (language === "es") {
		systemPrompt = `Responde SOLO en espanol.\n\n${systemPrompt}`;
	}

	if (!systemPrompt) {
		systemPrompt = `You are a meeting notes assistant. Generate structured notes with sections: Summary, Key Points, Action Items, Decisions.`;
	}

	// force_cpu comes from the UI when the user explicitly acknowledged the warning
	// and chose "Generate on CPU". Otherwise we use the config value.
	const numGpu = force_cpu ? 0 : (getCurrentNumGpu() ?? undefined);
	const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: getCurrentModel(),
			stream: true,
			keep_alive: 0,
			...(numGpu !== undefined ? { options: { num_gpu: numGpu } } : {}),
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: `Generate meeting notes from this transcript:\n\n${transcript}` },
			],
		}),
	});

	if (!res.ok) {
		const errText = await res.text();
		return Response.json({ error: `Ollama error: ${errText}` }, { status: 500 });
	}

	// Stream Ollama response as SSE
	const encoder = new TextEncoder();
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();

	const stream = new ReadableStream({
		async start(controller) {
			let buffer = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const json = JSON.parse(line);
						if (json.message?.content) {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify({ token: json.message.content })}\n\n`));
						}
						if (json.done) {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
						}
					} catch {}
				}
			}
			controller.close();
		},
	});

	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
	});
}

// --- Speaker voice memory (proxy to Python server) ---
async function handleSaveVoice(req: Request): Promise<Response> {
	const body = await req.json();
	try {
		const res = await fetch(`${TRANSCRIPTION_SERVER}/voices/save`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return Response.json(await res.json());
	} catch (e) {
		return Response.json({ error: (e as Error).message }, { status: 500 });
	}
}

async function handleDeleteVoice(req: Request): Promise<Response> {
	const body = await req.json();
	try {
		const res = await fetch(`${TRANSCRIPTION_SERVER}/voices/delete`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return Response.json(await res.json());
	} catch (e) {
		return Response.json({ error: (e as Error).message }, { status: 500 });
	}
}

async function handleListVoices(): Promise<Response> {
	try {
		const res = await fetch(`${TRANSCRIPTION_SERVER}/voices`);
		return Response.json(await res.json());
	} catch (e) {
		return Response.json({ voices: [] });
	}
}

// --- Models API: hardware-aware catalog + selection + streaming download ---
interface OllamaTag { name: string; size: number }

async function getInstalledOllamaModels(): Promise<Set<string>> {
	try {
		const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return new Set();
		const data = await res.json() as { models?: OllamaTag[] };
		return new Set((data.models || []).map((m) => m.name));
	} catch {
		return new Set();
	}
}

async function handleListModels(): Promise<Response> {
	try {
		const [hwRes, installed] = await Promise.all([
			fetch(`${TRANSCRIPTION_SERVER}/hardware`),
			getInstalledOllamaModels(),
		]);
		if (!hwRes.ok) return Response.json({ error: "Hardware probe failed" }, { status: 500 });
		const hw = await hwRes.json() as { models?: Array<{ id: string }>; [k: string]: unknown };
		const cfg = loadConfig();
		const models = (hw.models || []).map((m) => ({
			...m,
			installed: installed.has(m.id),
		}));
		return Response.json({
			...hw,
			models,
			current: {
				id: cfg.ollama_model,
				num_gpu: cfg.ollama_num_gpu,
			},
		});
	} catch (e) {
		return Response.json({ error: (e as Error).message }, { status: 500 });
	}
}

async function handleSelectModel(req: Request): Promise<Response> {
	const body = await req.json() as { id?: string; num_gpu?: number };
	if (!body.id) return Response.json({ error: "No model id" }, { status: 400 });

	// Validate the model exists in our catalog and is appropriate for this hardware.
	let hw: { models?: Array<{ id: string; gpu_compatible: boolean; vram_mb: number }>; free_vram_mb?: number };
	try {
		const r = await fetch(`${TRANSCRIPTION_SERVER}/hardware`);
		hw = await r.json();
	} catch (e) {
		return Response.json({ error: "Hardware probe failed" }, { status: 500 });
	}
	const model = hw.models?.find((m) => m.id === body.id);
	if (!model) return Response.json({ error: `Unknown model: ${body.id}` }, { status: 400 });

	// Force CPU mode if user picked a model that won't fit in GPU, even if they didn't specify.
	let numGpu = body.num_gpu;
	if (numGpu === undefined) {
		numGpu = model.gpu_compatible ? undefined : 0;
	}

	saveConfig({ ollama_model: body.id, ollama_num_gpu: numGpu });
	console.log(`[heed] Model switched: ${body.id} (gpu=${numGpu === 0 ? "off" : numGpu === undefined ? "auto" : numGpu})`);
	return Response.json({ ok: true, model: body.id, num_gpu: numGpu });
}

// SSE stream of `ollama pull <id>` progress.
function handleModelPull(url: URL): Response {
	const id = url.searchParams.get("id");
	if (!id) return new Response("Missing id", { status: 400 });

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			let closed = false;
			const send = (data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					closed = true;
				}
			};

			try {
				const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: id, stream: true }),
				});
				if (!res.ok || !res.body) {
					send({ error: `Ollama pull failed: ${res.status}` });
					controller.close();
					return;
				}
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buf = "";
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					const lines = buf.split("\n");
					buf = lines.pop() || "";
					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const evt = JSON.parse(line);
							send(evt);
						} catch {}
					}
				}
				send({ done: true });
			} catch (e) {
				send({ error: (e as Error).message });
			} finally {
				controller.close();
			}
		},
	});
	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
	});
}

// --- Speaker diarization via transcription server ---
async function handleDiarize(req: Request): Promise<Response> {
	const body = await req.json();
	if (!body.wavPath) return Response.json({ error: "No wavPath provided" }, { status: 400 });

	try {
		const res = await fetch(`${TRANSCRIPTION_SERVER}/diarize`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				wav_path: body.wavPath,
				srt_path: body.srtPath || null,
				min_speakers: body.minSpeakers || null,
				max_speakers: body.maxSpeakers || null,
			}),
		});
		const data = await res.json();
		return Response.json(data);
	} catch (e) {
		return Response.json({ error: `Diarization failed: ${(e as Error).message}` }, { status: 500 });
	}
}

// --- First-launch setup wizard ------------------------------------------------
//
// The wizard exists so a non-technical user (e.g. a Mac-using teammate watching
// a Discord launch) can go from "I downloaded heed" to "I'm transcribing my
// first meeting" without ever opening a terminal.
//
// Three things must be present before heed can do its job:
//   1. Ollama running on :11434          (LLM backend for AI Notes)
//   2. ffmpeg in PATH                     (audio capture and conversion)
//   3. The hardware-default LLM pulled    (the model picker default)
//
// All three are detected here. The frontend reads /api/setup/check and decides
// whether to show the wizard. The install endpoints stream stdout via SSE so
// the user sees progress in real time.

type DetectedOS = "linux-debian" | "linux-fedora" | "linux-arch" | "linux-other" | "macos" | "windows" | "unknown";

function detectOS(): DetectedOS {
	if (process.platform === "darwin") return "macos";
	if (process.platform === "win32") return "windows";
	if (process.platform !== "linux") return "unknown";
	try {
		const osRelease = readFileSync("/etc/os-release", "utf-8");
		const idLine = osRelease.split("\n").find((l) => l.startsWith("ID="));
		const idLikeLine = osRelease.split("\n").find((l) => l.startsWith("ID_LIKE="));
		const id = (idLine?.split("=")[1] || "").replace(/"/g, "").toLowerCase();
		const idLike = (idLikeLine?.split("=")[1] || "").replace(/"/g, "").toLowerCase();
		const all = `${id} ${idLike}`;
		if (/debian|ubuntu|mint|pop/.test(all)) return "linux-debian";
		if (/fedora|rhel|centos|rocky|alma/.test(all)) return "linux-fedora";
		if (/arch|manjaro|endeavour|garuda/.test(all)) return "linux-arch";
		return "linux-other";
	} catch {
		return "linux-other";
	}
}

function which(cmd: string): string | null {
	try {
		const r = Bun.spawnSync(["which", cmd]);
		const out = new TextDecoder().decode(r.stdout).trim();
		return out || null;
	} catch {
		return null;
	}
}

async function isOllamaRunning(): Promise<boolean> {
	try {
		const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
		return res.ok;
	} catch {
		return false;
	}
}

interface SetupCheckResult {
	os: DetectedOS;
	ollama: { installed: boolean; running: boolean };
	ffmpeg: { installed: boolean; path: string | null };
	model: { default_id: string | null; installed: boolean };
	all_ready: boolean;
}

async function handleSetupCheck(): Promise<Response> {
	const os = detectOS();

	const ollamaPath = which("ollama");
	const ollamaRunning = await isOllamaRunning();

	const ffmpegPath = which("ffmpeg");

	// Default model from current config (auto-seeded by hardware on first launch)
	let defaultModelId: string | null = loadConfig().ollama_model || null;
	if (!defaultModelId) {
		// Config not seeded yet — ask Python directly
		try {
			const r = await fetch(`${TRANSCRIPTION_SERVER}/hardware`, { signal: AbortSignal.timeout(5000) });
			if (r.ok) {
				const hw = await r.json() as { default_model?: string };
				defaultModelId = hw.default_model || null;
			}
		} catch {}
	}

	// Is the default model already pulled to ollama?
	let modelInstalled = false;
	if (defaultModelId && ollamaRunning) {
		try {
			const tags = await getInstalledOllamaModels();
			modelInstalled = tags.has(defaultModelId);
		} catch {}
	}

	const result: SetupCheckResult = {
		os,
		ollama: { installed: !!ollamaPath, running: ollamaRunning },
		ffmpeg: { installed: !!ffmpegPath, path: ffmpegPath },
		model: { default_id: defaultModelId, installed: modelInstalled },
		all_ready: !!ollamaPath && ollamaRunning && !!ffmpegPath && modelInstalled,
	};
	return Response.json(result);
}

// SSE wrapper that spawns a shell command and streams stdout+stderr line by line.
// Used by /api/setup/install-ollama and /api/setup/install-ffmpeg.
function spawnSSEStream(command: string[], shellPipe = false): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			let closed = false;
			const send = (data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					closed = true;
				}
			};

			try {
				// shellPipe=true wraps the command in `bash -c "..."` so pipes work.
				// Used for `curl ... | sh` style installers.
				const finalCmd = shellPipe ? ["bash", "-c", command.join(" ")] : command;
				send({ status: "started", cmd: command.join(" ") });

				const proc = Bun.spawn(finalCmd, {
					stdout: "pipe",
					stderr: "pipe",
				});

				// Pipe both stdout and stderr line by line
				const pumpStream = async (stream: ReadableStream<Uint8Array>, source: "stdout" | "stderr") => {
					const reader = stream.getReader();
					const dec = new TextDecoder();
					let buf = "";
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						buf += dec.decode(value, { stream: true });
						const lines = buf.split("\n");
						buf = lines.pop() || "";
						for (const line of lines) {
							if (line.trim()) send({ source, line });
						}
					}
					if (buf.trim()) send({ source, line: buf });
				};

				await Promise.all([
					pumpStream(proc.stdout as ReadableStream<Uint8Array>, "stdout"),
					pumpStream(proc.stderr as ReadableStream<Uint8Array>, "stderr"),
				]);

				const code = await proc.exited;
				send({ status: "done", code });
			} catch (e) {
				send({ status: "error", error: (e as Error).message });
			} finally {
				controller.close();
			}
		},
	});
	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
	});
}

function handleInstallOllama(): Response {
	// Official installer: same script the Ollama docs recommend.
	// Works on macOS (writes to /usr/local/bin) and Linux (asks for sudo password
	// mid-execution if needed — that part will fail silently in the wizard, in
	// which case we fall back to the copy-the-command path).
	return spawnSSEStream(["curl", "-fsSL", "https://ollama.com/install.sh", "|", "sh"], true);
}

function handleInstallFfmpeg(): Response {
	const os = detectOS();
	let cmd: string[];
	switch (os) {
		case "linux-debian":
			cmd = ["sudo", "apt-get", "install", "-y", "ffmpeg"];
			break;
		case "linux-fedora":
			cmd = ["sudo", "dnf", "install", "-y", "ffmpeg"];
			break;
		case "linux-arch":
			cmd = ["sudo", "pacman", "-S", "--noconfirm", "ffmpeg"];
			break;
		case "macos":
			cmd = ["brew", "install", "ffmpeg"];
			break;
		default:
			return Response.json(
				{ error: `Auto-install of ffmpeg is not supported on ${os}. Install ffmpeg manually.` },
				{ status: 400 },
			);
	}
	return spawnSSEStream(cmd);
}

// --- Sessions CRUD ---
function handleListSessions(): Response {
	const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
	const sessions = files
		.map((f) => {
			try {
				return JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
			} catch {
				return null;
			}
		})
		.filter(Boolean)
		.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
	return Response.json(sessions);
}

async function handleCreateSession(req: Request): Promise<Response> {
	const session = await req.json();
	const id = session.id || `session-${Date.now()}`;
	const data = {
		...session,
		id,
		createdAt: session.createdAt || new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(data, null, 2));
	return Response.json(data);
}

async function handlePatchSession(req: Request, url: URL): Promise<Response> {
	const id = url.searchParams.get("id");
	if (!id) return Response.json({ error: "No id" }, { status: 400 });
	const filePath = join(SESSIONS_DIR, `${id}.json`);
	if (!existsSync(filePath)) return Response.json({ error: "Not found" }, { status: 404 });

	const existing = JSON.parse(readFileSync(filePath, "utf-8"));
	const patch = await req.json();
	const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
	writeFileSync(filePath, JSON.stringify(merged, null, 2));
	return Response.json(merged);
}

function handleDeleteSession(url: URL): Response {
	const id = url.searchParams.get("id");
	if (!id) return Response.json({ error: "No id" }, { status: 400 });
	const filePath = join(SESSIONS_DIR, `${id}.json`);
	if (existsSync(filePath)) unlinkSync(filePath);
	return Response.json({ ok: true });
}

// --- One-line summary via Ollama (for sessions list preview) ---
async function handleSummaryLine(req: Request): Promise<Response> {
	const { transcript } = await req.json();
	if (!transcript || transcript.length < 30) {
		return Response.json({ summary: "" });
	}

	// Truncate transcript to first 1500 chars to keep it fast
	const text = transcript.slice(0, 1500);

	try {
		const numGpu = getCurrentNumGpu();
		const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: getCurrentModel(),
				stream: false,
				keep_alive: 0,
				...(numGpu !== undefined ? { options: { num_gpu: numGpu } } : {}),
				messages: [
					{
						role: "system",
						content: "You generate ONE single sentence (max 12 words) that captures the main topic of a meeting transcript. Output ONLY the sentence, no quotes, no prefixes, no explanation. Be concrete and specific. IMPORTANT: respond in the SAME language as the transcript — if it's in Spanish, your sentence must be in Spanish. If English, respond in English.",
					},
					{ role: "user", content: text },
				],
			}),
		});
		if (!res.ok) return Response.json({ summary: "" });
		const data = await res.json() as { message?: { content?: string } };
		const summary = (data.message?.content || "").trim().replace(/^["']|["']$/g, "").split("\n")[0];
		return Response.json({ summary });
	} catch {
		return Response.json({ summary: "" });
	}
}

// --- File download ---
function handleDownload(url: URL): Response {
	const filePath = url.searchParams.get("path");
	if (!filePath || !existsSync(filePath)) return Response.json({ error: "File not found" }, { status: 404 });
	const content = readFileSync(filePath, "utf-8");
	const name = filePath.split("/").pop() || "download.txt";
	return new Response(content, {
		headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
	});
}

// --- Save recording from browser (mic) ---
async function handleSaveRecording(req: Request): Promise<Response> {
	const formData = await req.formData();
	const file = formData.get("audio") as File;
	if (!file) return Response.json({ error: "No audio" }, { status: 400 });
	const safeName = `recording-${Date.now()}.webm`;
	const filePath = join(UPLOAD_DIR, safeName);
	const buffer = await file.arrayBuffer();
	writeFileSync(filePath, Buffer.from(buffer));
	return Response.json({ path: filePath });
}

// --- Audio recording via ffmpeg + PipeWire/PulseAudio ---
// Uses ffmpeg -f pulse which works reliably with PipeWire's PulseAudio layer
let recorderProc: ReturnType<typeof Bun.spawn> | null = null;
let recorderPath: string | null = null;

function getMonitorSource(): string | null {
	const result = Bun.spawnSync(["pactl", "list", "sources", "short"]);
	const output = new TextDecoder().decode(result.stdout);
	const lines = output.split("\n");
	for (const line of lines) {
		if (line.includes(".monitor") && !line.includes("SUSPENDED")) return line.split("\t")[1];
	}
	// Fallback: any monitor
	for (const line of lines) {
		if (line.includes(".monitor")) return line.split("\t")[1];
	}
	return null;
}

function getMicSource(): string | null {
	const result = Bun.spawnSync(["pactl", "list", "sources", "short"]);
	const output = new TextDecoder().decode(result.stdout);
	const lines = output.split("\n");
	for (const line of lines) {
		if (!line.includes(".monitor") && line.includes("input") && !line.includes("SUSPENDED")) return line.split("\t")[1];
	}
	return "default";
}

async function handleSysRecordStart(req: Request): Promise<Response> {
	let mode = "both";
	try { const body = await req.json(); mode = body.mode || "both"; } catch {}

	if (recorderProc) {
		try { recorderProc.kill("SIGKILL"); } catch {}
		recorderProc = null;
	}

	const ts = Date.now();
	const mic = getMicSource() || "default";
	const monitor = getMonitorSource();

	// Naming convention: dual-capture-* signals stereo (L=mic, R=system) → channel-based diarization later.
	const isDual = mode === "both" && !!monitor;
	recorderPath = join(UPLOAD_DIR, `${isDual ? "dual-capture" : "capture"}-${ts}.wav`);

	let args: string[];

	if (mode === "system") {
		if (!monitor) return Response.json({ error: "No system audio monitor found" }, { status: 500 });
		args = ["ffmpeg", "-y", "-f", "pulse", "-i", monitor, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", recorderPath];
	} else if (mode === "mic") {
		args = ["ffmpeg", "-y", "-f", "pulse", "-i", mic, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", recorderPath];
	} else {
		// both: keep mic and system in SEPARATE physical channels (L=mic, R=system).
		// Downstream we split them and run diarization independently — this is what unlocks
		// real overlap detection when two people speak at the same time.
		if (!monitor) {
			// Fallback to mic only
			args = ["ffmpeg", "-y", "-f", "pulse", "-i", mic, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", recorderPath];
		} else {
			args = [
				"ffmpeg", "-y",
				"-f", "pulse", "-i", mic,
				"-f", "pulse", "-i", monitor,
				"-filter_complex", "[0:a]aresample=16000,pan=mono|c0=c0[micL];[1:a]aresample=16000,pan=mono|c0=c0[sysR];[micL][sysR]amerge=inputs=2[out]",
				"-map", "[out]",
				"-ar", "16000", "-ac", "2", "-c:a", "pcm_s16le",
				recorderPath,
			];
		}
	}

	recorderProc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

	// Start PipeWire loopback so browser can visualize system audio
	if (mode === "system" || mode === "both") {
		startLevelMeter();
	}

	return Response.json({ recording: true, mode, path: recorderPath, monitor: monitor || null, mic });
}

// --- System audio level meter via ffmpeg reading monitor source ---
let levelProc: ReturnType<typeof Bun.spawn> | null = null;
let sysLevels: number[] = new Array(24).fill(0);

function startLevelMeter() {
	const monitor = getMonitorSource();
	if (!monitor) return;

	// ffmpeg reads the monitor and outputs raw PCM to stdout
	levelProc = Bun.spawn([
		"ffmpeg", "-f", "pulse", "-i", monitor,
		"-f", "s16le", "-ar", "16000", "-ac", "1",
		"-"  // output to stdout
	], { stdout: "pipe", stderr: "pipe" });

	// Read stdout in chunks and compute levels
	const stdout = levelProc.stdout as ReadableStream<Uint8Array>;
	(async () => {
		const reader = stdout.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			// value is Uint8Array of 16-bit PCM samples
			const samples = new Int16Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / 2));
			if (samples.length < 24) continue;
			const binSize = Math.floor(samples.length / 24);
			for (let i = 0; i < 24; i++) {
				let sumSq = 0;
				for (let j = 0; j < binSize; j++) {
					const s = samples[i * binSize + j] || 0;
					sumSq += s * s;
				}
				const rms = Math.sqrt(sumSq / binSize) / 32768;
				sysLevels[i] = Math.round(Math.pow(rms, 0.5) * 255);
			}
		}
	})().catch(() => {});
}

function stopLevelMeter() {
	if (levelProc) {
		try { levelProc.kill(); } catch {}
		levelProc = null;
	}
	sysLevels = new Array(24).fill(0);
}

function handleSysLevelsSSE(): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			const iv = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(sysLevels)}\n\n`));
				} catch {
					clearInterval(iv);
				}
			}, 50); // 20fps — smooth enough, low overhead

			// Close when recording stops (checked every tick above via try/catch)
		}
	});
	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
	});
}

async function handleSysRecordStop(): Promise<Response> {
	if (!recorderProc || !recorderPath) return Response.json({ error: "Not recording" }, { status: 400 });

	recorderProc.kill("SIGINT");
	await recorderProc.exited.catch(() => {});
	await new Promise(r => setTimeout(r, 500));

	const path = recorderPath;
	recorderProc = null;
	recorderPath = null;

	stopLevelMeter();

	if (!existsSync(path)) return Response.json({ error: "Recording file not created" }, { status: 500 });

	return Response.json({ path });
}

// --- Meeting auto-detector ---
// Watches PipeWire clients for meeting apps (zoom, meet, teams, discord, etc.)
// Streams notifications via SSE to the frontend.
const MEETING_APPS = [
	{ pattern: /zoom/i, name: "Zoom" },
	{ pattern: /meet|chrome.*meet/i, name: "Google Meet" },
	{ pattern: /teams|MSTeams/i, name: "Microsoft Teams" },
	{ pattern: /discord/i, name: "Discord" },
	{ pattern: /webex/i, name: "Webex" },
	{ pattern: /skype/i, name: "Skype" },
	{ pattern: /jitsi/i, name: "Jitsi" },
	{ pattern: /slack.*call/i, name: "Slack Call" },
];

function detectMeetingApps(): { app: string; raw: string }[] {
	try {
		const result = Bun.spawnSync(["pactl", "list", "clients"]);
		const output = new TextDecoder().decode(result.stdout);
		const clients = output.split("Client #").slice(1);

		const detected: { app: string; raw: string }[] = [];
		for (const client of clients) {
			const nameMatch = client.match(/application\.name\s*=\s*"([^"]+)"/);
			const procMatch = client.match(/application\.process\.binary\s*=\s*"([^"]+)"/);
			const name = nameMatch?.[1] || "";
			const proc = procMatch?.[1] || "";
			const combined = `${name} ${proc}`;

			for (const app of MEETING_APPS) {
				if (app.pattern.test(combined)) {
					detected.push({ app: app.name, raw: name });
					break;
				}
			}
		}
		return detected;
	} catch {
		return [];
	}
}

function handleDetectorStream(): Response {
	const encoder = new TextEncoder();
	let lastApps = new Set<string>();

	const stream = new ReadableStream({
		start(controller) {
			let closed = false;
			const send = (data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					closed = true;
				}
			};

			const tick = () => {
				if (closed) return;
				const detected = detectMeetingApps();
				const currentApps = new Set(detected.map((d) => d.app));

				// New apps detected
				for (const d of detected) {
					if (!lastApps.has(d.app)) {
						send({ event: "meeting_started", app: d.app });
					}
				}
				// Apps that ended
				for (const app of lastApps) {
					if (!currentApps.has(app)) {
						send({ event: "meeting_ended", app });
					}
				}
				lastApps = currentApps;
			};

			// Initial tick
			tick();
			const iv = setInterval(tick, 3000);

			// Heartbeat to keep connection alive
			const heartbeat = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`: ping\n\n`));
				} catch {
					closed = true;
				}
			}, 15000);

			// Cleanup on cancel
			(controller as any)._cleanup = () => {
				closed = true;
				clearInterval(iv);
				clearInterval(heartbeat);
			};
		},
		cancel() {
			// noop — handled by closed flag
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

// --- Auto-recovery for orphaned recordings ---
// When heed crashes mid-recording, ffmpeg has already written the WAV to disk.
// On next startup, we scan the uploads dir for WAVs that don't belong to any
// session and surface them to the frontend as recoverable.
interface OrphanedRecording {
	path: string;
	filename: string;
	size_mb: number;
	created: string; // ISO date
	duration_estimate_s: number; // estimated from file size (16kHz 16-bit mono ≈ 32KB/s, stereo ≈ 64KB/s)
	is_dual: boolean;
}

function handleListOrphaned(): Response {
	if (!existsSync(UPLOAD_DIR)) return Response.json({ recordings: [] });

	// Collect all WAV files in uploads
	const wavFiles = readdirSync(UPLOAD_DIR)
		.filter((f) => f.endsWith(".wav") && (f.startsWith("capture-") || f.startsWith("dual-capture-")))
		.filter((f) => {
			// Exclude sub-files created by the Python split (mic/sys channels)
			return !f.includes("-mic.wav") && !f.includes("-sys.wav");
		});

	// Collect all WAV paths referenced by existing sessions
	const sessionPaths = new Set<string>();
	if (existsSync(SESSIONS_DIR)) {
		for (const sf of readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"))) {
			try {
				const session = JSON.parse(readFileSync(join(SESSIONS_DIR, sf), "utf-8"));
				if (session.files?.wav) sessionPaths.add(session.files.wav);
			} catch {}
		}
	}

	// An orphan = WAV exists but no session references it
	const orphans: OrphanedRecording[] = [];
	for (const f of wavFiles) {
		const fullPath = join(UPLOAD_DIR, f);
		if (sessionPaths.has(fullPath)) continue;

		const stat = Bun.file(fullPath);
		const sizeBytes = stat.size;
		const isDual = f.startsWith("dual-capture-");
		// Estimate duration: 16kHz × 16-bit × channels = bytes/sec
		const bytesPerSec = isDual ? 64000 : 32000; // stereo vs mono
		const durationS = Math.round(sizeBytes / bytesPerSec);

		// Extract timestamp from filename: capture-{ts}.wav or dual-capture-{ts}.wav
		const tsMatch = f.match(/(\d+)\.wav$/);
		const ts = tsMatch ? parseInt(tsMatch[1]) : Date.now();

		orphans.push({
			path: fullPath,
			filename: f,
			size_mb: Math.round(sizeBytes / 1024 / 1024 * 10) / 10,
			created: new Date(ts).toISOString(),
			duration_estimate_s: durationS,
			is_dual: isDual,
		});
	}

	// Sort newest first
	orphans.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
	return Response.json({ recordings: orphans });
}

function handleDiscardOrphaned(url: URL): Response {
	const path = url.searchParams.get("path");
	if (!path) return Response.json({ error: "No path" }, { status: 400 });
	// Safety: only allow deleting files inside UPLOAD_DIR
	if (!path.startsWith(UPLOAD_DIR)) return Response.json({ error: "Invalid path" }, { status: 400 });
	try {
		if (existsSync(path)) unlinkSync(path);
		// Also clean up any split files
		const base = path.replace(/\.wav$/, "");
		for (const suffix of ["-mic.wav", "-sys.wav", "-mic.wav.srt", "-sys.wav.srt", "-mic.txt", "-sys.txt"]) {
			const f = base + suffix;
			if (existsSync(f)) unlinkSync(f);
		}
		return Response.json({ ok: true });
	} catch (e) {
		return Response.json({ error: (e as Error).message }, { status: 500 });
	}
}

// --- Health check ---
async function handleHealth(): Promise<Response> {
	let ollamaOk = false;
	let txServer: any = { ready: false };
	try {
		const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
		ollamaOk = res.ok;
	} catch {}
	try {
		const res = await fetch(`${TRANSCRIPTION_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
		txServer = await res.json();
	} catch {}
	return Response.json({
		ollama: ollamaOk,
		whisper: txServer.whisper || false,
		pyannote: txServer.pyannote || false,
	});
}

// --- Router ---
const server = Bun.serve({
	port: PORT,
	idleTimeout: 255, // max allowed — pyannote + whisper can take a while
	async fetch(req) {
		const url = new URL(req.url);
		const method = req.method;

		if (method === "POST" && url.pathname === "/api/transcribe") return handleTranscribe(req);
		if (method === "POST" && url.pathname === "/api/summarize") return handleSummarize(req);
		if (method === "POST" && url.pathname === "/api/summary-line") return handleSummaryLine(req);
		if (method === "POST" && url.pathname === "/api/diarize") return handleDiarize(req);
		if (method === "GET" && url.pathname === "/api/sessions") return handleListSessions();
		if (method === "POST" && url.pathname === "/api/sessions") return handleCreateSession(req);
		if (method === "PATCH" && url.pathname === "/api/sessions") return handlePatchSession(req, url);
		if (method === "DELETE" && url.pathname === "/api/sessions") return handleDeleteSession(url);
		if (method === "GET" && url.pathname === "/api/templates") return handleListTemplates();
		if (method === "POST" && url.pathname === "/api/templates") return handleSaveTemplate(req);
		if (method === "DELETE" && url.pathname === "/api/templates") return handleDeleteTemplate(url);
		if (method === "GET" && url.pathname === "/api/voices") return handleListVoices();
		if (method === "POST" && url.pathname === "/api/voices/save") return handleSaveVoice(req);
		if (method === "POST" && url.pathname === "/api/voices/delete") return handleDeleteVoice(req);
		if (method === "GET" && url.pathname === "/api/models") return handleListModels();
		if (method === "POST" && url.pathname === "/api/models/select") return handleSelectModel(req);
		if (method === "GET" && url.pathname === "/api/models/pull") return handleModelPull(url);
		if (method === "GET" && url.pathname === "/api/setup/check") return handleSetupCheck();
		if (method === "GET" && url.pathname === "/api/setup/install-ollama") return handleInstallOllama();
		if (method === "GET" && url.pathname === "/api/setup/install-ffmpeg") return handleInstallFfmpeg();
		if (method === "GET" && url.pathname === "/api/meeting-detector") return handleDetectorStream();
		if (method === "GET" && url.pathname === "/api/download") return handleDownload(url);
		if (method === "POST" && url.pathname === "/api/recording") return handleSaveRecording(req);
		if (method === "POST" && url.pathname === "/api/sysrecord/start") return handleSysRecordStart(req);
		if (method === "POST" && url.pathname === "/api/sysrecord/stop") return handleSysRecordStop();
		if (method === "GET" && url.pathname === "/api/sysrecord/levels") return handleSysLevelsSSE();
		if (method === "GET" && url.pathname === "/api/health") return handleHealth();
		if (method === "GET" && url.pathname === "/api/recovery/list") return handleListOrphaned();
		if (method === "DELETE" && url.pathname === "/api/recovery/discard") return handleDiscardOrphaned(url);

		return serveStatic(url.pathname) || new Response("Not Found", { status: 404 });
	},
});

console.log(`
  ┌──────────────────────────────────┐
  │                                  │
  │   heed app running on :${PORT}     │
  │   http://localhost:${PORT}          │
  │                                  │
  └──────────────────────────────────┘
`);

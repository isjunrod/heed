import { useEffect, useRef } from "react";
import { recordingApi } from "@/api/recording.ts";
import { sessionsApi } from "@/api/sessions.ts";
import { notesApi } from "@/api/notes.ts";
import { useRecordingStore } from "@/stores/recording.ts";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useUIStore } from "@/stores/ui.ts";
import { useHealthStore } from "@/stores/health.ts";
import { fmtDate } from "@/lib/format.ts";
import { resolveLanguage } from "@/lib/languages.ts";

// Always send a language the ACTIVE engine can transcribe (Parakeet has no auto-detect),
// resolved at send-time from the live health info — independent of UI render timing.
function effectiveLanguage(requested: string): string {
	return resolveLanguage(requested, useHealthStore.getState().health.languages);
}

interface UseRecordingOptions {
	micBars: React.RefObject<HTMLDivElement[] | null>;
	systemBars: React.RefObject<HTMLDivElement[] | null>;
	getLanguage: () => string;
}

const VIZ_BARS = 24;

export function useRecording({ micBars, systemBars, getLanguage }: UseRecordingOptions) {
	const store = useRecordingStore();
	const showToast = useUIStore((s) => s.showToast);
	const reloadSessions = useSessionsStore((s) => s.load);

	const tickInterval = useRef<number | null>(null);
	const micStreamRef = useRef<MediaStream | null>(null);
	const audioCtxRef = useRef<AudioContext | null>(null);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const sysEventRef = useRef<EventSource | null>(null);
	const liveEventRef = useRef<EventSource | null>(null);
	const sysLevelsRef = useRef<number[]>(new Array(24).fill(0));
	const micCurrentRef = useRef<number[]>(new Array(VIZ_BARS).fill(0));
	const sysCurrentRef = useRef<number[]>(new Array(VIZ_BARS).fill(0));
	const animFrameRef = useRef<number | null>(null);

	const start = async () => {
		try {
			const data = await recordingApi.start("both");
			// System audio (ScreenCaptureKit) needs Screen Recording permission. If it's not
			// granted yet, the server does NOT start recording — we ask the user to grant it and
			// press record again. The timer never starts until the permission is resolved.
			if ((data as { permissionNeeded?: boolean }).permissionNeeded) {
				showToast("Otorgá permiso de Grabación de Pantalla (se abrió Ajustes) y volvé a grabar");
				return;
			}
			if ((data as { error?: string }).error) {
				showToast((data as { error?: string }).error || "Failed to start");
				return;
			}

			store.startRecording();

			tickInterval.current = window.setInterval(() => useRecordingStore.getState().tick(), 1000);

			// Mic stream for visualizer
			try {
				micStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
				audioCtxRef.current = new AudioContext();
				analyserRef.current = audioCtxRef.current.createAnalyser();
				analyserRef.current.fftSize = 64;
				audioCtxRef.current.createMediaStreamSource(micStreamRef.current).connect(analyserRef.current);
			} catch {}

			// System levels via SSE
			sysLevelsRef.current = new Array(24).fill(0);
			sysEventRef.current = new EventSource("/api/sysrecord/levels");
			sysEventRef.current.onmessage = (e) => {
				try { sysLevelsRef.current = JSON.parse(e.data); } catch {}
			};

			// Live transcription via SSE — segments appear while recording. Short delay just to
			// let the recorder create the WAV; the heavy model warm-up is pre-loaded server-side.
			setTimeout(() => {
				if (!useRecordingStore.getState().recording) return;
				const liveLang = encodeURIComponent(effectiveLanguage(getLanguage()));
				liveEventRef.current = new EventSource(`/api/sysrecord/live?lang=${liveLang}`);
				// "segment" = chunk mode (append, Whisper/CPU); "live" = full mode (replace, Parakeet/MLX).
				liveEventRef.current.addEventListener("segment", (e) => {
					try {
						useRecordingStore.getState().appendSegment(JSON.parse(e.data));
					} catch {}
				});
				liveEventRef.current.addEventListener("live", (e) => {
					try {
						useRecordingStore.getState().setLiveSegment(JSON.parse(e.data));
					} catch {}
				});
				// Audio-quality hint (heed differentiator): warn when the mic is too quiet/echoey.
				liveEventRef.current.addEventListener("quality", (e) => {
					try {
						useRecordingStore.getState().setLiveQuality(JSON.parse(e.data));
					} catch {}
				});
				liveEventRef.current.onerror = () => {
					liveEventRef.current?.close();
					liveEventRef.current = null;
				};
			}, 300);

			startVisualizerLoop();
		} catch (e) {
			showToast(`Error: ${(e as Error).message}`);
		}
	};

	const startVisualizerLoop = () => {
		const tick = () => {
			if (!useRecordingStore.getState().recording) {
				micBars.current?.forEach((b) => { if (b) b.style.height = "2px"; });
				systemBars.current?.forEach((b) => { if (b) b.style.height = "2px"; });
				return;
			}

			// Mic levels (real, from browser AnalyserNode)
			let micLevels = new Array(VIZ_BARS).fill(0);
			if (analyserRef.current) {
				const freq = new Uint8Array(analyserRef.current.frequencyBinCount);
				analyserRef.current.getByteFrequencyData(freq);
				micLevels = Array.from(freq).slice(0, VIZ_BARS);
			}

			// System levels (from server SSE, already 24 bins)
			const sysLevels = sysLevelsRef.current;

			// Animate mic bars
			const micCurrent = micCurrentRef.current;
			for (let i = 0; i < VIZ_BARS; i++) {
				const target = micLevels[i] || 0;
				micCurrent[i] = target > micCurrent[i]
					? micCurrent[i] + (target - micCurrent[i]) * 0.5
					: micCurrent[i] + (target - micCurrent[i]) * 0.25;
				const bar = micBars.current?.[i];
				if (bar) bar.style.height = `${Math.max(2, micCurrent[i] / 3.5)}px`;
			}

			// Animate system bars
			const sysCurrent = sysCurrentRef.current;
			for (let i = 0; i < VIZ_BARS; i++) {
				const target = sysLevels[i] || 0;
				sysCurrent[i] = target > sysCurrent[i]
					? sysCurrent[i] + (target - sysCurrent[i]) * 0.5
					: sysCurrent[i] + (target - sysCurrent[i]) * 0.25;
				const bar = systemBars.current?.[i];
				if (bar) bar.style.height = `${Math.max(2, sysCurrent[i] / 3.5)}px`;
			}

			animFrameRef.current = requestAnimationFrame(tick);
		};
		tick();
	};

	const stop = async () => {
		if (tickInterval.current) {
			clearInterval(tickInterval.current);
			tickInterval.current = null;
		}

		// Stop visualizer + live transcription sources
		micStreamRef.current?.getTracks().forEach((t) => t.stop());
		micStreamRef.current = null;
		try { audioCtxRef.current?.close(); } catch {}
		audioCtxRef.current = null;
		analyserRef.current = null;
		sysEventRef.current?.close();
		sysEventRef.current = null;
		liveEventRef.current?.close();
		liveEventRef.current = null;
		if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

		micBars.current?.forEach((b) => { if (b) b.style.height = "2px"; });
		systemBars.current?.forEach((b) => { if (b) b.style.height = "2px"; });
		micCurrentRef.current = new Array(VIZ_BARS).fill(0);
		sysCurrentRef.current = new Array(VIZ_BARS).fill(0);

		store.stopRecording();

		try {
			const { path, streaming, streamText } = await recordingApi.stop();
			await finalizeRecording(path, streaming, streamText);
		} catch (e) {
			showToast(`Stop failed: ${(e as Error).message}`);
		}
	};

	const finalizeRecording = async (audioPath: string, streaming?: boolean, streamText?: string) => {
		const lang = effectiveLanguage(getLanguage());
		const seconds = useRecordingStore.getState().seconds;

		// SEAMLESS stop (streaming mic-only): the streamed text IS the final — same model, same
		// text that's already on screen. Just finalize it (no re-transcribe, no re-type) instead
		// of running the full process-stream. (Dual/system recordings still use the full pass below
		// so the other party's channel gets transcribed + diarized.)
		const isDual = audioPath.includes("dual-capture-");
		if (streaming && !isDual) {
			const text = (streamText || useRecordingStore.getState().transcript || "").trim();
			const words = text.split(/\s+/).filter(Boolean);
			if (words.length === 0) {
				useRecordingStore.getState().reset();
				showToast("No se detectó voz en la grabación — nada que guardar");
				return;
			}
			const seg = { speaker: "Me", start: 0, end: seconds, text, channel: "mic" as const };
			useRecordingStore.getState().setResult({
				success: true, text,
				files: { wav: audioPath, srt: "", txt: "" },
				metadata: { language: lang, model: "parakeet-stream" },
				speakers: ["Me"], segments: [seg], embeddings: {},
				wordCount: words.length,
			});
			try {
				const created = await sessionsApi.create({
					title: words.slice(0, 8).join(" ") + (words.length > 8 ? "..." : ""),
					createdAt: new Date().toISOString(), duration: seconds, language: lang,
					transcript: text, speakers: ["Me"], segments: [seg], embeddings: {},
					files: { wav: audioPath, srt: "", txt: "" }, aiNotes: "", summary: "", tags: [], pinned: false,
				});
				useRecordingStore.getState().setSessionId(created.id);
				reloadSessions();
			} catch { /* keep the on-screen result even if persistence fails */ }
			return;
		}
		// DON'T clear live segments — they stay visible in Speakers.
		// We only need to: 1) transcribe remaining chunks, 2) run pyannote.
		useRecordingStore.getState().setProcessing("Finishing transcription...", 30);

		// Send live segments + WAV to the server. It transcribes the remaining
		// audio (what live missed) and runs pyannote for speaker reveal.
		const res = await fetch("/api/transcribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: audioPath, language: lang, diarize: true }),
		});

		if (!res.body) {
			showToast("Finalize failed");
			return;
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let currentEvent = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (line.startsWith("event: ")) {
					currentEvent = line.slice(7).trim();
				} else if (line.startsWith("data: ")) {
					try {
						const data = JSON.parse(line.slice(6));
						switch (currentEvent) {
							case "step":
								useRecordingStore.getState().setProcessing(data.message, useRecordingStore.getState().processProgress);
								break;
							case "segment":
								// Append NEW segments from the full processing
								// (these fill in what live missed)
								useRecordingStore.getState().appendSegment(data);
								break;
							case "speakers":
								// Pyannote finished — replace "???" with real names
								useRecordingStore.getState().revealSpeakers(
									data.speakers || [],
									data.segments || [],
									data.embeddings || {},
								);
								break;
							case "result": {
								useRecordingStore.getState().setResult(data);
								const words = (data.text || "").split(/\s+/).filter(Boolean);
								// Guard: don't persist a phantom session when nothing was captured
								// (no transcript and no segments) — tell the user instead of saving
								// an empty "Meeting ..." card.
								const hasSegs = Array.isArray(data.segments) && data.segments.length > 0;
								if (words.length === 0 && !hasSegs) {
									showToast("No se detectó voz en la grabación — nada que guardar");
									break;
								}
								const heuristicTitle = words.length > 0
									? words.slice(0, 8).join(" ") + (words.length > 8 ? "..." : "")
									: `Meeting ${fmtDate(new Date().toISOString())}`;

								const created = await sessionsApi.create({
									title: heuristicTitle,
									createdAt: new Date().toISOString(),
									duration: seconds,
									language: lang,
									transcript: data.text,
									speakers: data.speakers || [],
									segments: data.segments || [],
									embeddings: data.embeddings || {},
									files: data.files,
									aiNotes: "",
									summary: "",
									tags: [],
									pinned: false,
								});
								useRecordingStore.getState().setSessionId(created.id);
								reloadSessions();
								if (data.text && data.text.length > 30) {
									notesApi.summaryLine(data.text)
										.then((d) => {
											if (d.summary) {
												sessionsApi.patch(created.id, {
													title: d.summary,
													summary: d.summary,
												}).then(() => reloadSessions());
											}
										})
										.catch(() => {});
								}
								break;
							}
							case "error":
								showToast(`Error: ${data.message}`);
								break;
						}
					} catch {}
				}
			}
		}
	};

	useEffect(() => {
		return () => {
			if (tickInterval.current) clearInterval(tickInterval.current);
			if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
			micStreamRef.current?.getTracks().forEach((t) => t.stop());
			try { audioCtxRef.current?.close(); } catch {}
			liveEventRef.current?.close();
			sysEventRef.current?.close();
		};
	}, []);

	return { start, stop };
}

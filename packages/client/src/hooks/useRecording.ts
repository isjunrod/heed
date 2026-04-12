import { useEffect, useRef } from "react";
import { recordingApi } from "@/api/recording.ts";
import { sessionsApi } from "@/api/sessions.ts";
import { notesApi } from "@/api/notes.ts";
import { useRecordingStore } from "@/stores/recording.ts";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useUIStore } from "@/stores/ui.ts";
import { fmtDate } from "@/lib/format.ts";

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

			// Live transcription via SSE — segments appear while recording
			setTimeout(() => {
				if (!useRecordingStore.getState().recording) return;
				const liveLang = encodeURIComponent(getLanguage());
				liveEventRef.current = new EventSource(`/api/sysrecord/live?lang=${liveLang}`);
				liveEventRef.current.addEventListener("segment", (e) => {
					try {
						const seg = JSON.parse(e.data);
						useRecordingStore.getState().appendSegment(seg);
					} catch {}
				});
				liveEventRef.current.onerror = () => {
					liveEventRef.current?.close();
					liveEventRef.current = null;
				};
			}, 2000);

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
			const { path } = await recordingApi.stop();
			await finalizeRecording(path);
		} catch (e) {
			showToast(`Stop failed: ${(e as Error).message}`);
		}
	};

	const finalizeRecording = async (audioPath: string) => {
		const lang = getLanguage();
		const seconds = useRecordingStore.getState().seconds;
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

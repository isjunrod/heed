import { useEffect, useRef } from "react";
import { recordingApi } from "@/api/recording.ts";
import { transcribe } from "@/api/transcribe.ts";
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

		// Stop visualizer sources
		micStreamRef.current?.getTracks().forEach((t) => t.stop());
		micStreamRef.current = null;
		try { audioCtxRef.current?.close(); } catch {}
		audioCtxRef.current = null;
		analyserRef.current = null;
		sysEventRef.current?.close();
		sysEventRef.current = null;
		if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

		micBars.current?.forEach((b) => { if (b) b.style.height = "2px"; });
		systemBars.current?.forEach((b) => { if (b) b.style.height = "2px"; });
		micCurrentRef.current = new Array(VIZ_BARS).fill(0);
		sysCurrentRef.current = new Array(VIZ_BARS).fill(0);

		store.stopRecording();

		try {
			const { path } = await recordingApi.stop();
			await processRecording(path);
		} catch (e) {
			showToast(`Stop failed: ${(e as Error).message}`);
		}
	};

	const processRecording = async (audioPath: string) => {
		const lang = getLanguage();
		const seconds = useRecordingStore.getState().seconds;

		await transcribe(
			{ url: audioPath, language: lang, diarize: true },
			{
				onStep: (msg) => useRecordingStore.getState().setProcessing(msg, useRecordingStore.getState().processProgress),
				onProgress: (pct) => useRecordingStore.getState().setProcessing(useRecordingStore.getState().processStep, pct),
				onResult: async (result) => {
					useRecordingStore.getState().setResult(result);
					// Auto-save session
					try {
						const created = await sessionsApi.create({
							title: `Meeting ${fmtDate(new Date().toISOString())}`,
							createdAt: new Date().toISOString(),
							duration: seconds,
							language: lang,
							transcript: result.text,
							speakers: result.speakers || [],
							segments: result.segments || [],
							embeddings: result.embeddings || {},
							files: result.files,
							aiNotes: "",
							summary: "",
							tags: [],
							pinned: false,
						});
						useRecordingStore.getState().setSessionId(created.id);
						reloadSessions();
						// Generate one-line summary in background
						if (result.text && result.text.length > 30) {
							notesApi.summaryLine(result.text)
								.then((d) => {
									if (d.summary) sessionsApi.patch(created.id, { summary: d.summary }).then(() => reloadSessions());
								})
								.catch(() => {});
						}
					} catch (e) {
						showToast(`Save failed: ${(e as Error).message}`);
					}
				},
				onError: (msg) => {
					showToast(`Error: ${msg}`);
					useRecordingStore.getState().reset();
				},
			},
		);
	};

	useEffect(() => {
		return () => {
			if (tickInterval.current) clearInterval(tickInterval.current);
			if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
			micStreamRef.current?.getTracks().forEach((t) => t.stop());
			try { audioCtxRef.current?.close(); } catch {}
			sysEventRef.current?.close();
		};
	}, []);

	return { start, stop };
}

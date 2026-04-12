import { useRef, useEffect, useState } from "react";
import { useRecording } from "@/hooks/useRecording.ts";
import { useRecordingStore } from "@/stores/recording.ts";
import { useLocalStorage } from "@/hooks/useLocalStorage.ts";
import { RecordButton } from "./RecordButton.tsx";
import { Timer } from "./Timer.tsx";
import { Visualizer } from "./Visualizer.tsx";
import vizStyles from "./Visualizer.module.css";
import { LanguageSelect } from "./LanguageSelect.tsx";
import { ResultCard } from "./ResultCard.tsx";
import styles from "./RecordPage.module.css";

const FAST_PROCESS_MESSAGES_EN = [
	"Transcribing mic...",
	"Transcribing sys...",
	"Transcribing pyannote...",
	"Aligning speaker timeline...",
	"Merging segments...",
	"It's almost ready!",
];

export function RecordPage() {
	const micBars = useRef<HTMLDivElement[]>([]);
	const systemBars = useRef<HTMLDivElement[]>([]);
	const [language, setLanguage] = useLocalStorage<string>("heed-language", "es");

	const { start, stop } = useRecording({
		micBars,
		systemBars,
		getLanguage: () => language,
	});

	const { recording, processing, processStep, segments, transcript } = useRecordingStore();
	// Show result card when recording (live preview) or after stop (final result)
	const showResult = recording || processing || segments.length > 0 || !!transcript;
	// Block recording button while processing (transcribing + diarizing after stop)
	const canRecord = !recording && !processing;
	const [rotatingStep, setRotatingStep] = useState("");
	const [rotatingStepKey, setRotatingStepKey] = useState(0);

	// Listen for meeting detector trigger
	useEffect(() => {
		const handler = () => {
			if (!useRecordingStore.getState().recording && !useRecordingStore.getState().processing) start();
		};
		window.addEventListener("heed:start-recording", handler);
		return () => window.removeEventListener("heed:start-recording", handler);
	}, [start]);

	useEffect(() => {
		if (!processing) {
			setRotatingStep("");
			return;
		}

		const liveStep = (processStep || "").trim();
		const poolRaw = [liveStep, ...FAST_PROCESS_MESSAGES_EN].filter(Boolean);
		const uniquePool = Array.from(new Map(poolRaw.map((msg) => [msg.toLowerCase(), msg])).values());

		const updateMessage = (msg: string) => {
			setRotatingStep(msg);
			setRotatingStepKey((k) => k + 1);
		};

		let idx = 0;
		updateMessage(uniquePool[0] || "It's almost ready!");

		const id = window.setInterval(() => {
			if (!uniquePool.length) return;
			idx = (idx + 1) % uniquePool.length;
			updateMessage(uniquePool[idx]);
		}, 2000);

		return () => clearInterval(id);
	}, [processing, processStep]);

	return (
		<div>
			<div className={styles.center}>
				<Timer seconds={useRecordingStore((s) => s.seconds)} />
				<div className={vizStyles.dualWrap}>
					<Visualizer ref={micBars} barCount={24} variant="mic" label="Microphone" />
					<Visualizer ref={systemBars} barCount={24} variant="system" label="System" />
				</div>
				{processing ? (
					<div className={styles.processingStatus}>
						<div className={styles.processingDot} />
						<span key={rotatingStepKey} className={styles.processingText}>
							{rotatingStep || processStep || "Finalizing..."}
						</span>
					</div>
				) : (
					<RecordButton recording={recording} onClick={() => (recording ? stop() : canRecord ? start() : null)} />
				)}
				<div className={styles.label}>
					{recording ? "Recording... click to stop" : processing ? "" : !showResult ? "Click to start recording" : ""}
				</div>
				{!processing && (
					<div className={styles.options}>
						<LanguageSelect value={language} onChange={setLanguage} />
					</div>
				)}
			</div>

			{showResult && <ResultCard />}
		</div>
	);
}

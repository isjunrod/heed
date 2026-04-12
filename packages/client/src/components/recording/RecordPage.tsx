import { useRef, useEffect } from "react";
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

	// Listen for meeting detector trigger
	useEffect(() => {
		const handler = () => {
			if (!useRecordingStore.getState().recording && !useRecordingStore.getState().processing) start();
		};
		window.addEventListener("heed:start-recording", handler);
		return () => window.removeEventListener("heed:start-recording", handler);
	}, [start]);

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
						<span>{processStep || "Finalizing..."}</span>
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

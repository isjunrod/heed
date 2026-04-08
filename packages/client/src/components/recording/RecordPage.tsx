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

	const { recording, processing, processStep, processProgress, transcript } = useRecordingStore();
	const showResult = !!transcript && !processing;

	// Listen for meeting detector trigger
	useEffect(() => {
		const handler = () => {
			if (!useRecordingStore.getState().recording) start();
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
				<RecordButton recording={recording} onClick={() => (recording ? stop() : start())} />
				<div className={styles.label}>
					{recording ? "Recording... click to stop" : processing ? "Processing..." : "Click to start recording"}
				</div>
				<div className={styles.options}>
					<LanguageSelect value={language} onChange={setLanguage} />
				</div>
			</div>

			{processing && (
				<div className={styles.progressCard}>
					<div className={styles.progressStep}>
						<div className={styles.progressDot} />
						<span>{processStep}</span>
					</div>
					<div className={styles.progressBar}>
						<div className={styles.progressFill} style={{ width: `${processProgress}%` }} />
					</div>
				</div>
			)}

			{showResult && <ResultCard />}
		</div>
	);
}

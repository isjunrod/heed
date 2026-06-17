import { useEffect } from "react";
import { useUIStore, type Page } from "@/stores/ui.ts";
import { useHealthStore } from "@/stores/health.ts";
import { useModelsStore } from "@/stores/models.ts";
import { ModelPicker } from "@/components/models/ModelPicker.tsx";
import styles from "./Nav.module.css";

const TABS: Array<{ id: Page; label: string }> = [
	{ id: "record", label: "Record" },
	{ id: "sessions", label: "Sessions" },
];

const WHISPER_QUALITY_LABEL: Record<string, string> = {
	very_good: "very good",
	excellent: "high",
	best: "max",
};

const WHISPER_SPEED_LABEL: Record<string, string> = {
	fast: "fast",
	medium: "medium",
	slower: "slower",
};

export function Nav() {
	const currentPage = useUIStore((s) => s.currentPage);
	const setPage = useUIStore((s) => s.setPage);
	const health = useHealthStore((s) => s.health);
	const checkHealth = useHealthStore((s) => s.check);
	const modelsData = useModelsStore((s) => s.data);
	const loadModels = useModelsStore((s) => s.load);
	const pickerOpen = useModelsStore((s) => s.pickerOpen);
	const openPicker = useModelsStore((s) => s.openPicker);
	const closePicker = useModelsStore((s) => s.closePicker);

	useEffect(() => {
		checkHealth();
		loadModels();
		const id = setInterval(checkHealth, 60000);
		return () => clearInterval(id);
	}, [checkHealth, loadModels]);

	const currentModel = modelsData?.models.find((m) => m.id === modelsData.current?.id);
	const isCpuOnly = modelsData?.current?.num_gpu === 0;
	const whisperInfo = health.whisper_info || null;
	const pyannoteInfo = health.pyannote_info || null;
	const whisperPower = whisperInfo ? `${WHISPER_QUALITY_LABEL[whisperInfo.quality] || whisperInfo.quality} / ${WHISPER_SPEED_LABEL[whisperInfo.speed] || whisperInfo.speed}` : "detecting";
	// Show the REAL engine, not the nominal whisper tier. Apple Silicon runs Parakeet (Neural
	// Engine); CUDA/CPU run Whisper. Diarization is FluidAudio on Mac, pyannote elsewhere.
	const engine = health.languages?.engine;
	const engineLabel = !whisperInfo ? "..."
		: engine === "parakeet" ? "Parakeet v3"
		: engine === "mlx" ? `MLX ${whisperInfo.final_model}`
		: `whisper ${whisperInfo.final_model}`;
	const diarLabel = pyannoteInfo?.model?.toLowerCase().includes("fluidaudio") ? "FluidAudio" : "pyannote";

	return (
		<nav className={styles.nav}>
			<div className={styles.inner}>
				<div className={styles.leftBlock}>
					<a href="/" className={styles.brand}>heed</a>
				</div>

				<div className={styles.centerBlock}>
					<div className={styles.tabs}>
						{TABS.map((t) => (
							<button
								key={t.id}
								className={`${styles.tab} ${currentPage === t.id ? styles.tabActive : ""}`}
								onClick={() => setPage(t.id)}
								data-tour={t.id === "sessions" ? "sessions-tab" : undefined}
							>
								{t.label}
							</button>
						))}
					</div>
				</div>

				<div className={styles.rightBlock}>
					<div className={styles.status}>
						<button
							className={styles.modelChip}
							onClick={() => openPicker()}
							title="Click to switch AI model"
							data-tour="model-chip"
						>
							<span className={styles.modelChipDot} />
							<span className={styles.modelChipName}>
								{currentModel?.name || modelsData?.current?.id || "no model"}
							</span>
							{isCpuOnly && <span className={styles.modelChipBadge}>CPU</span>}
							{currentModel?.new && <span className={styles.modelChipNew}>NEW</span>}
							<span className={styles.modelChipChevron} aria-hidden="true">⌄</span>
						</button>
						<div
							className={`${styles.statusItem} ${styles.statusItemInfo}`}
							tabIndex={0}
							aria-label="Local notes engine (Ollama)"
						>
							<div className={`${styles.dot} ${health.ollama ? styles.dotOk : styles.dotErr}`} />
							<span className={styles.label}>ollama</span>
							<span className={styles.statusItemChevron} aria-hidden="true">⌄</span>
							<div className={styles.infoTooltip} role="tooltip">
								<div className={styles.infoTooltipHead}>
									<div className={styles.infoTooltipTitle}>Ollama</div>
									<span className={styles.infoTooltipBadge}>AI notes</span>
								</div>
								<div className={styles.infoTooltipLine}>Local LLM that writes the meeting <strong>notes</strong> from the transcript.</div>
								<div className={styles.infoTooltipLine}><strong>Model:</strong> {currentModel?.name || modelsData?.current?.id || "none selected"}</div>
								<div className={styles.infoTooltipReason}>Separate from transcription — heed transcribes locally, then Ollama summarizes.</div>
							</div>
						</div>
						<div
							className={`${styles.statusItem} ${styles.statusItemInfo}`}
							tabIndex={0}
							aria-label="Transcription engine details"
						>
							<div className={`${styles.dot} ${health.whisper ? styles.dotOk : styles.dotErr}`} />
							<span className={styles.label}>{engineLabel}</span>
							<span className={styles.statusItemChevron} aria-hidden="true">⌄</span>
							<div className={styles.infoTooltip} role="tooltip">
								<div className={styles.infoTooltipHead}>
									<div className={styles.infoTooltipTitle}>
										{engine === "parakeet" ? "Parakeet (Apple Neural Engine)" : engine === "mlx" ? "MLX-Whisper (Apple GPU)" : "Whisper auto profile"}
									</div>
									<span className={styles.infoTooltipBadge}>transcription</span>
								</div>
								{engine === "parakeet" ? (
									<>
										<div className={styles.infoTooltipLine}><strong>Model:</strong> parakeet-tdt-v3</div>
										<div className={styles.infoTooltipLine}><strong>Runs on:</strong> Apple Neural Engine</div>
										<div className={styles.infoTooltipLine}><strong>Languages:</strong> 28 European</div>
									</>
								) : (
									<>
										<div className={styles.infoTooltipLine}><strong>Final:</strong> {whisperInfo?.final_model || "small"}</div>
										<div className={styles.infoTooltipLine}><strong>Live:</strong> {whisperInfo?.live_model || "small"}</div>
										<div className={styles.infoTooltipLine}><strong>Power:</strong> {whisperPower}</div>
										<div className={styles.infoTooltipLine}><strong>Device:</strong> {whisperInfo?.device || "cpu"}</div>
									</>
								)}
								<div className={styles.infoTooltipReason}>{whisperInfo?.reason || "Detecting hardware and choosing the best engine."}</div>
							</div>
						</div>
						<div
							className={`${styles.statusItem} ${styles.statusItemInfo}`}
							tabIndex={0}
							aria-label="Speaker diarization details"
						>
							<div className={`${styles.dot} ${health.pyannote ? styles.dotOk : styles.dotErr}`} />
							<span className={styles.label}>{diarLabel}</span>
							<span className={styles.statusItemChevron} aria-hidden="true">⌄</span>
							<div className={styles.infoTooltip} role="tooltip">
								<div className={styles.infoTooltipHead}>
									<div className={styles.infoTooltipTitle}>{diarLabel === "FluidAudio" ? "FluidAudio diarization" : "Pyannote auto tuning"}</div>
									<span className={styles.infoTooltipBadge}>who said what</span>
								</div>
								{diarLabel === "FluidAudio" ? (
									<>
										<div className={styles.infoTooltipLine}><strong>Model:</strong> FluidAudio CoreML</div>
										<div className={styles.infoTooltipLine}><strong>Runs on:</strong> Apple Neural Engine</div>
										<div className={styles.infoTooltipLine}><strong>Token:</strong> none needed</div>
									</>
								) : (
									<>
										<div className={styles.infoTooltipLine}><strong>Model:</strong> {pyannoteInfo?.model || "pyannote/speaker-diarization-3.1"}</div>
										<div className={styles.infoTooltipLine}><strong>Device:</strong> {pyannoteInfo?.device || "cpu"}</div>
										<div className={styles.infoTooltipLine}><strong>Profile:</strong> {pyannoteInfo?.profile || "balanced"}</div>
										<div className={styles.infoTooltipLine}><strong>Batch:</strong> {pyannoteInfo?.batch_size || 8}</div>
										{pyannoteInfo?.cpu_threads ? (
											<div className={styles.infoTooltipLine}><strong>CPU threads:</strong> {pyannoteInfo.cpu_threads}</div>
										) : null}
									</>
								)}
								<div className={styles.infoTooltipReason}>{pyannoteInfo?.reason || "Tuning based on available hardware."}</div>
							</div>
						</div>
					</div>
				</div>
			</div>
			<ModelPicker open={pickerOpen} onClose={() => closePicker()} />
		</nav>
	);
}

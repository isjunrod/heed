import { useEffect, useState } from "react";
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
	very_good: "muy buena",
	excellent: "alta",
	best: "maxima",
};

const WHISPER_SPEED_LABEL: Record<string, string> = {
	fast: "rapida",
	medium: "media",
	slower: "lenta",
};

export function Nav() {
	const currentPage = useUIStore((s) => s.currentPage);
	const setPage = useUIStore((s) => s.setPage);
	const health = useHealthStore((s) => s.health);
	const checkHealth = useHealthStore((s) => s.check);
	const modelsData = useModelsStore((s) => s.data);
	const loadModels = useModelsStore((s) => s.load);
	const [pickerOpen, setPickerOpen] = useState(false);

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
	const whisperModelLabel = whisperInfo?.final_model || "...";
	const whisperPower = whisperInfo ? `${WHISPER_QUALITY_LABEL[whisperInfo.quality] || whisperInfo.quality} / ${WHISPER_SPEED_LABEL[whisperInfo.speed] || whisperInfo.speed}` : "detectando";

	return (
		<nav className={styles.nav}>
			<div className={styles.inner}>
				<a href="/" className={styles.brand}>heed</a>
				<div className={styles.tabs}>
					{TABS.map((t) => (
						<button
							key={t.id}
							className={`${styles.tab} ${currentPage === t.id ? styles.tabActive : ""}`}
							onClick={() => setPage(t.id)}
						>
							{t.label}
						</button>
					))}
				</div>
				<div className={styles.status}>
					<button
						className={styles.modelChip}
						onClick={() => setPickerOpen(true)}
						title="Click to switch AI model"
					>
						<span className={styles.modelChipDot} />
						<span className={styles.modelChipName}>
							{currentModel?.name || modelsData?.current?.id || "no model"}
						</span>
						{isCpuOnly && <span className={styles.modelChipBadge}>CPU</span>}
						{currentModel?.new && <span className={styles.modelChipNew}>NEW</span>}
					</button>
					<div className={styles.statusItem}>
						<div className={`${styles.dot} ${health.ollama ? styles.dotOk : styles.dotErr}`} />
						<span className={styles.label}>ollama</span>
					</div>
					<div className={`${styles.statusItem} ${styles.statusItemInfo}`}>
						<div className={`${styles.dot} ${health.whisper ? styles.dotOk : styles.dotErr}`} />
						<span className={styles.label}>whisper {whisperModelLabel}</span>
						<div className={styles.infoTooltip} role="tooltip">
							<div className={styles.infoTooltipTitle}>Whisper auto</div>
							<div className={styles.infoTooltipLine}><strong>Final:</strong> {whisperInfo?.final_model || "small"}</div>
							<div className={styles.infoTooltipLine}><strong>Live:</strong> {whisperInfo?.live_model || "small"}</div>
							<div className={styles.infoTooltipLine}><strong>Potencia:</strong> {whisperPower}</div>
							<div className={styles.infoTooltipLine}><strong>Device:</strong> {whisperInfo?.device || "cpu"}</div>
							<div className={styles.infoTooltipReason}>{whisperInfo?.reason || "Detectando hardware y ajustando el mejor perfil."}</div>
						</div>
					</div>
					<div className={`${styles.statusItem} ${styles.statusItemInfo}`}>
						<div className={`${styles.dot} ${health.pyannote ? styles.dotOk : styles.dotErr}`} />
						<span className={styles.label}>pyannote</span>
						<div className={styles.infoTooltip} role="tooltip">
							<div className={styles.infoTooltipTitle}>Pyannote auto-tuning</div>
							<div className={styles.infoTooltipLine}><strong>Model:</strong> {pyannoteInfo?.model || "pyannote/speaker-diarization-3.1"}</div>
							<div className={styles.infoTooltipLine}><strong>Device:</strong> {pyannoteInfo?.device || "cpu"}</div>
							<div className={styles.infoTooltipLine}><strong>Perfil:</strong> {pyannoteInfo?.profile || "balanced"}</div>
							<div className={styles.infoTooltipLine}><strong>Batch:</strong> {pyannoteInfo?.batch_size || 8}</div>
							{pyannoteInfo?.cpu_threads ? (
								<div className={styles.infoTooltipLine}><strong>CPU threads:</strong> {pyannoteInfo.cpu_threads}</div>
							) : null}
							<div className={styles.infoTooltipReason}>{pyannoteInfo?.reason || "Ajustando en base a VRAM/CPU disponibles."}</div>
						</div>
					</div>
				</div>
			</div>
			<ModelPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
		</nav>
	);
}

import { useEffect, useState } from "react";
import { useUIStore, type Page } from "@/stores/ui.ts";
import { useHealthStore } from "@/stores/health.ts";
import { useModelsStore } from "@/stores/models.ts";
import { ModelPicker } from "@/components/models/ModelPicker.tsx";
import styles from "./Nav.module.css";

const TABS: Array<{ id: Page; label: string }> = [
	{ id: "record", label: "Record" },
	{ id: "sessions", label: "Sessions" },
	{ id: "actions", label: "Actions" },
];

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
					<div className={styles.statusItem}>
						<div className={`${styles.dot} ${health.whisper ? styles.dotOk : styles.dotErr}`} />
						<span className={styles.label}>whisper</span>
					</div>
					<div className={styles.statusItem}>
						<div className={`${styles.dot} ${health.pyannote ? styles.dotOk : styles.dotErr}`} />
						<span className={styles.label}>pyannote</span>
					</div>
				</div>
			</div>
			<ModelPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
		</nav>
	);
}

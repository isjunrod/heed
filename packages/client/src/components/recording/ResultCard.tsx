import { useState, useEffect } from "react";
import { useRecordingStore } from "@/stores/recording.ts";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useTemplatesStore } from "@/stores/templates.ts";
import { useModelsStore } from "@/stores/models.ts";
import { useUIStore } from "@/stores/ui.ts";
import { generateNotes } from "@/api/notes.ts";
import { sessionsApi } from "@/api/sessions.ts";
import { Tabs } from "@/components/shared/Tabs.tsx";
import { SpeakerView } from "@/components/speakers/SpeakerView.tsx";
import { NotesView } from "@/components/ai-notes/NotesView.tsx";
import styles from "./ResultCard.module.css";

type Tab = "speakers" | "notes";

export function ResultCard() {
	const {
		transcript, segments, speakers, embeddings, currentSessionId, notesText, setNotes,
	} = useRecordingStore();
	const showToast = useUIStore((s) => s.showToast);
	const reloadSessions = useSessionsStore((s) => s.load);
	const { templates, load: loadTemplates } = useTemplatesStore();
	const modelsData = useModelsStore((s) => s.data);
	const loadModels = useModelsStore((s) => s.load);

	const [activeTab, setActiveTab] = useState<Tab>("speakers");
	const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
	const [generating, setGenerating] = useState(false);
	const [streamingNotes, setStreamingNotes] = useState("");
	const [templateId, setTemplateId] = useState<string>("general");

	// Load templates + models on mount (models needed for GPU runtime check)
	useEffect(() => { loadTemplates(); loadModels(); }, [loadTemplates, loadModels]);

	// Check if the current model fits in free VRAM right now
	const currentModel = modelsData?.models.find((m) => m.id === modelsData.current?.id);
	const fitsGpu = currentModel?.gpu_runtime_ok !== false; // true if ok or undefined (no data yet)

	// Reset speaker names when speakers change (new recording)
	useEffect(() => {
		setSpeakerNames({});
	}, [segments]);

	const tabs = [
		{ id: "speakers", label: "Speakers" },
		{ id: "notes", label: "AI Notes" },
	];

	const handleCopy = () => {
		if (activeTab === "notes") {
			navigator.clipboard.writeText(notesText);
		} else {
			// Copy with speaker labels
			const text = segments.map((s) => `${speakerNames[s.speaker] || s.speaker}: ${s.text}`).join("\n");
			navigator.clipboard.writeText(text);
		}
		showToast("Copied");
	};

	const handleCopyPlain = () => {
		navigator.clipboard.writeText(transcript);
		showToast("Copied plain text");
	};

	const handleGenerate = async (forceCpu = false) => {
		if (!transcript || generating) return;
		setGenerating(true);
		setStreamingNotes("");
		setActiveTab("notes");
		try {
			let acc = "";
			await generateNotes(
				transcript,
				"es",
				templateId,
				{
					onToken: (tok) => {
						acc += tok;
						setStreamingNotes(acc);
					},
					onDone: async (full) => {
						setNotes(full);
						setStreamingNotes("");
						if (currentSessionId) {
							await sessionsApi.patch(currentSessionId, { aiNotes: full });
							reloadSessions();
						}
					},
				},
				forceCpu,
			);
		} catch (e) {
			showToast(`Error: ${(e as Error).message}`);
		} finally {
			setGenerating(false);
		}
	};

	const handleRename = (original: string, newName: string) => {
		setSpeakerNames((prev) => ({ ...prev, [original]: newName }));
	};

	const handleMerge = async (from: string, into: string) => {
		const newSegments = segments.map((s) =>
			s.speaker === from ? { ...s, speaker: into } : s,
		);
		const newSpeakers = speakers.filter((s) => s !== from);
		// Update store via direct update
		useRecordingStore.setState({ segments: newSegments, speakers: newSpeakers });
		setSpeakerNames((prev) => {
			const copy = { ...prev };
			delete copy[from];
			return copy;
		});
		if (currentSessionId) {
			await sessionsApi.patch(currentSessionId, { segments: newSegments, speakers: newSpeakers });
			reloadSessions();
		}
		showToast("Merged");
	};

	const displayNotes = streamingNotes || notesText;
	const isStreaming = !!streamingNotes && generating;

	return (
		<div className={styles.card}>
			<Tabs tabs={tabs} active={activeTab} onChange={(id) => setActiveTab(id as Tab)} />

			{activeTab === "speakers" && (
				<SpeakerView
					segments={segments}
					speakers={speakers}
					embeddings={embeddings}
					speakerNames={speakerNames}
					onRename={handleRename}
					onMerge={handleMerge}
				/>
			)}

			{activeTab === "notes" && (
				<NotesView
					notes={displayNotes}
					streaming={isStreaming}
					placeholder='Click "Generate AI notes" below'
				/>
			)}

			{activeTab === "notes" && !fitsGpu && !generating && (
				<div className={styles.gpuWarn}>
					<span className={styles.gpuWarnText}>
						{currentModel?.name || "Current model"} doesn't fit in your GPU right now. It will run on CPU (~3-4x slower).
					</span>
				</div>
			)}

			<div className={styles.actions}>
				<button className={styles.btn} onClick={handleCopy}>Copy</button>
				{activeTab === "speakers" && (
					<button className={styles.btn} onClick={handleCopyPlain}>Copy plain text</button>
				)}
				{activeTab === "notes" && (
					<>
						<select
							className={styles.templateSelect}
							value={templateId}
							onChange={(e) => setTemplateId(e.target.value)}
						>
							{templates.map((t) => (
								<option key={t.id} value={t.id}>{t.name}</option>
							))}
						</select>
						{fitsGpu ? (
							<button className={styles.btn} onClick={() => handleGenerate(false)} disabled={generating}>
								{generating ? "Generating..." : "Generate AI notes"}
							</button>
						) : (
							<button className={styles.btnCpu} onClick={() => handleGenerate(true)} disabled={generating}>
								{generating ? "Generating on CPU..." : "Generate on CPU"}
							</button>
						)}
					</>
				)}
			</div>
		</div>
	);
}

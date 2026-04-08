import { useState, useEffect } from "react";
import { useRecordingStore } from "@/stores/recording.ts";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useTemplatesStore } from "@/stores/templates.ts";
import { useUIStore } from "@/stores/ui.ts";
import { generateNotes } from "@/api/notes.ts";
import { sessionsApi } from "@/api/sessions.ts";
import { Tabs } from "@/components/shared/Tabs.tsx";
import { SpeakerView } from "@/components/speakers/SpeakerView.tsx";
import { NotesView } from "@/components/ai-notes/NotesView.tsx";
import styles from "./ResultCard.module.css";

type Tab = "transcript" | "speakers" | "notes";

export function ResultCard() {
	const {
		transcript, segments, speakers, embeddings, currentSessionId, notesText, setNotes,
	} = useRecordingStore();
	const showToast = useUIStore((s) => s.showToast);
	const reloadSessions = useSessionsStore((s) => s.load);
	const { templates, load: loadTemplates } = useTemplatesStore();

	const hasSpeakers = segments.length > 0;
	const [activeTab, setActiveTab] = useState<Tab>("transcript");
	const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
	const [generating, setGenerating] = useState(false);
	const [streamingNotes, setStreamingNotes] = useState("");
	const [templateId, setTemplateId] = useState<string>("general");

	// Load templates on mount
	useEffect(() => { loadTemplates(); }, [loadTemplates]);

	// Reset speaker names when speakers change (new recording)
	useEffect(() => {
		setSpeakerNames({});
	}, [segments]);

	const tabs = [
		{ id: "transcript", label: "Transcript" },
		{ id: "speakers", label: "Speakers", disabled: !hasSpeakers, disabledReason: "No speakers detected" },
		{ id: "notes", label: "AI Notes" },
	];

	const handleCopy = () => {
		let text = transcript;
		if (activeTab === "speakers") {
			text = segments.map((s) => `${speakerNames[s.speaker] || s.speaker}: ${s.text}`).join("\n");
		} else if (activeTab === "notes") {
			text = notesText;
		}
		navigator.clipboard.writeText(text);
		showToast("Copied");
	};

	const handleGenerate = async () => {
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

			{activeTab === "transcript" && (
				<div className={styles.text}>{transcript}</div>
			)}

			{activeTab === "speakers" && hasSpeakers && (
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

			<div className={styles.actions}>
				<button className={styles.btn} onClick={handleCopy}>Copy</button>
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
						<button className={styles.btn} onClick={handleGenerate} disabled={generating}>
							{generating ? "Generating..." : "Generate AI notes"}
						</button>
					</>
				)}
			</div>
		</div>
	);
}

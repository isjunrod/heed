import { useState, useEffect } from "react";
import type { Session } from "@heed/shared";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useTemplatesStore } from "@/stores/templates.ts";
import { useUIStore } from "@/stores/ui.ts";
import { generateNotes } from "@/api/notes.ts";
import { fmtDate, fmtDuration } from "@/lib/format.ts";
import { Tabs } from "@/components/shared/Tabs.tsx";
import { SpeakerView } from "@/components/speakers/SpeakerView.tsx";
import { NotesView } from "@/components/ai-notes/NotesView.tsx";
import { TitleInput } from "./TitleInput.tsx";
import styles from "./SessionDetail.module.css";

interface Props {
	session: Session;
	onBack: () => void;
}

type TabId = "transcript" | "speakers" | "notes";

export function SessionDetail({ session, onBack }: Props) {
	const update = useSessionsStore((s) => s.update);
	const showToast = useUIStore((s) => s.showToast);
	const { templates, load: loadTemplates } = useTemplatesStore();

	const [activeTab, setActiveTab] = useState<TabId>("transcript");
	const [templateId, setTemplateId] = useState<string>("general");
	const [generating, setGenerating] = useState(false);
	const [streamingNotes, setStreamingNotes] = useState("");
	const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});

	useEffect(() => { loadTemplates(); }, [loadTemplates]);

	const hasSpeakers = (session.segments?.length || 0) > 0;
	const meta = [
		fmtDate(session.createdAt),
		session.duration ? fmtDuration(session.duration) : null,
		session.language ? `lang: ${session.language}` : null,
		session.speakers?.length ? `${session.speakers.length} speaker${session.speakers.length > 1 ? "s" : ""}` : null,
	].filter(Boolean).join(" · ");

	const tabs = [
		{ id: "transcript", label: "Transcript" },
		{ id: "speakers", label: "Speakers", disabled: !hasSpeakers, disabledReason: "No speakers detected" },
		{ id: "notes", label: "AI Notes" },
	];

	const handleRemoveTag = async (tag: string) => {
		const newTags = (session.tags || []).filter((t) => t !== tag);
		await update(session.id, { tags: newTags });
	};

	const handleCopy = () => {
		let text = session.transcript || "";
		if (activeTab === "speakers" && session.segments) {
			text = session.segments.map((s) => `${speakerNames[s.speaker] || s.speaker}: ${s.text}`).join("\n");
		} else if (activeTab === "notes") {
			text = session.aiNotes || "";
		}
		navigator.clipboard.writeText(text);
		showToast("Copied");
	};

	const handleGenerate = async () => {
		if (!session.transcript || generating) return;
		setGenerating(true);
		setStreamingNotes("");
		setActiveTab("notes");
		try {
			let acc = "";
			await generateNotes(
				session.transcript,
				session.language || "es",
				templateId,
				{
					onToken: (tok) => { acc += tok; setStreamingNotes(acc); },
					onDone: async (full) => {
						setStreamingNotes("");
						await update(session.id, { aiNotes: full });
					},
				},
			);
		} catch (e) {
			showToast(`Error: ${(e as Error).message}`);
		} finally {
			setGenerating(false);
		}
	};

	const handleSpeakerRename = (original: string, newName: string) => {
		setSpeakerNames((prev) => ({ ...prev, [original]: newName }));
	};

	const handleSpeakerMerge = async (from: string, into: string) => {
		const newSegments = (session.segments || []).map((s) =>
			s.speaker === from ? { ...s, speaker: into } : s,
		);
		const newSpeakers = (session.speakers || []).filter((s) => s !== from);
		await update(session.id, { segments: newSegments, speakers: newSpeakers });
		showToast("Merged");
	};

	const displayNotes = streamingNotes || session.aiNotes || "";
	const isStreaming = !!streamingNotes && generating;

	return (
		<div>
			<div className={styles.header}>
				<TitleInput sessionId={session.id} value={session.title || ""} tags={session.tags || []} />
				<div className={styles.actions}>
					<button className={styles.btn} onClick={onBack}>← Back</button>
				</div>
			</div>

			<div className={styles.meta}>{meta}</div>

			{(session.tags && session.tags.length > 0) && (
				<div className={styles.tagsRow}>
					{session.tags.map((t) => (
						<span key={t} className={styles.tag}>
							#{t}
							<span className={styles.tagRemove} onClick={() => handleRemoveTag(t)}>×</span>
						</span>
					))}
				</div>
			)}

			<Tabs tabs={tabs} active={activeTab} onChange={(id) => setActiveTab(id as TabId)} />

			{activeTab === "transcript" && <div className={styles.text}>{session.transcript || ""}</div>}

			{activeTab === "speakers" && (
				<SpeakerView
					segments={session.segments || []}
					speakers={session.speakers || []}
					embeddings={session.embeddings}
					speakerNames={speakerNames}
					onRename={handleSpeakerRename}
					onMerge={handleSpeakerMerge}
				/>
			)}

			{activeTab === "notes" && (
				<NotesView
					notes={displayNotes}
					streaming={isStreaming}
					placeholder='Click "Generate AI notes" below'
				/>
			)}

			<div className={styles.actionsRow} style={{ marginTop: "12px" }}>
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

import { useEffect, useMemo, useState } from "react";
import type { Session, ActionItem, ActionFilter } from "@heed/shared";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useUIStore } from "@/stores/ui.ts";
import { fmtDate } from "@/lib/format.ts";
import styles from "./ActionsPage.module.css";

function extractActions(sessions: Session[]): ActionItem[] {
	const actions: ActionItem[] = [];
	for (const s of sessions) {
		if (!s.aiNotes) continue;
		const lines = s.aiNotes.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(/^\s*[-*]\s*\[([ xX])\]\s*(.+)$/);
			if (m) {
				actions.push({
					id: `${s.id}__${i}`,
					sessionId: s.id,
					sessionTitle: s.title || "Untitled",
					sessionDate: s.createdAt,
					lineIdx: i,
					done: m[1].toLowerCase() === "x",
					text: m[2].trim().replace(/\*\*/g, ""),
				});
			}
		}
	}
	return actions.sort((a, b) => new Date(b.sessionDate).getTime() - new Date(a.sessionDate).getTime());
}

export function ActionsPage() {
	const { sessions, load, update, view } = useSessionsStore();
	const setPage = useUIStore((s) => s.setPage);

	const [filter, setFilter] = useState<ActionFilter>("open");

	useEffect(() => { load(); }, [load]);

	const allActions = useMemo(() => extractActions(sessions), [sessions]);
	const filtered = useMemo(() => {
		return allActions.filter((a) => {
			if (filter === "open") return !a.done;
			if (filter === "done") return a.done;
			return true;
		});
	}, [allActions, filter]);

	const open = allActions.filter((a) => !a.done).length;
	const done = allActions.length - open;

	const handleToggle = async (action: ActionItem) => {
		const session = sessions.find((s) => s.id === action.sessionId);
		if (!session?.aiNotes) return;
		const lines = session.aiNotes.split("\n");
		const line = lines[action.lineIdx];
		if (!line) return;
		lines[action.lineIdx] = action.done
			? line.replace(/\[x\]/i, "[ ]")
			: line.replace(/\[\s\]/, "[x]");
		await update(session.id, { aiNotes: lines.join("\n") });
	};

	const handleSourceClick = (sessionId: string) => {
		const session = sessions.find((s) => s.id === sessionId);
		if (session) {
			setPage("sessions");
			view(session);
		}
	};

	return (
		<div>
			<div className={styles.header}>
				<div className={styles.stats}>
					<strong>{open}</strong> open · <strong>{done}</strong> done · <strong>{allActions.length}</strong> total
				</div>
				<div className={styles.filter}>
					{(["open", "done", "all"] as ActionFilter[]).map((f) => (
						<button
							key={f}
							className={`${styles.filterBtn} ${filter === f ? styles.active : ""}`}
							onClick={() => setFilter(f)}
						>
							{f.charAt(0).toUpperCase() + f.slice(1)}
						</button>
					))}
				</div>
			</div>

			<div className={styles.grid}>
				{filtered.length === 0 ? (
					<div className={styles.empty}>
						{filter === "open"
							? "No open action items. Generate AI notes on a session to extract them."
							: filter === "done"
								? "No completed action items yet."
								: "No action items found."}
					</div>
				) : (
					filtered.map((a) => (
						<div key={a.id} className={`${styles.card} ${a.done ? styles.done : ""}`}>
							<div
								className={`${styles.checkbox} ${a.done ? styles.done : ""}`}
								onClick={(e) => { e.stopPropagation(); handleToggle(a); }}
							>
								{a.done && "✓"}
							</div>
							<div className={styles.text}>{a.text}</div>
							<div className={styles.source} onClick={() => handleSourceClick(a.sessionId)}>
								↗ {a.sessionTitle} · {fmtDate(a.sessionDate)}
							</div>
						</div>
					))
				)}
			</div>
		</div>
	);
}

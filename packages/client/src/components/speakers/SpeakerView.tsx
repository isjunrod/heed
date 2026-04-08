import { useState, useMemo } from "react";
import type { Segment } from "@heed/shared";
import { speakerColor } from "@/lib/colors.ts";
import { useUIStore } from "@/stores/ui.ts";
import { voicesApi } from "@/api/voices.ts";
import { SpeakerMergeMenu } from "./SpeakerMergeMenu.tsx";
import styles from "./SpeakerView.module.css";

interface Props {
	segments: Segment[];
	speakers: string[];
	embeddings?: Record<string, number[]>;
	speakerNames: Record<string, string>;
	onRename: (original: string, newName: string) => void;
	onMerge: (from: string, into: string) => void;
}

export function SpeakerView({ segments, speakers, embeddings, speakerNames, onRename, onMerge }: Props) {
	const showToast = useUIStore((s) => s.showToast);
	const [mergeMenu, setMergeMenu] = useState<{ x: number; y: number; speaker: string } | null>(null);

	const colorMap = useMemo(() => {
		const map: Record<string, string> = {};
		speakers.forEach((s, i) => { map[s] = speakerColor(i); });
		return map;
	}, [speakers]);

	if (!segments?.length) {
		return <div className={styles.placeholder}>No speakers detected</div>;
	}

	const handleRename = async (speaker: string) => {
		const current = speakerNames[speaker] || speaker;
		const newName = window.prompt(`Rename "${current}" to:`, current);
		if (!newName?.trim()) return;
		const finalName = newName.trim();
		if (finalName === current) return;

		// If the new name collides with another existing speaker (raw label or display name),
		// perform a MERGE instead of a rename. This matches user intent — typing the same
		// name as an existing speaker should fold them together, not duplicate the label.
		const target = speakers.find((s) => s !== speaker && (s === finalName || speakerNames[s] === finalName));
		if (target) {
			onMerge(speaker, target);
			showToast(`Merged into ${finalName}`);
			return;
		}

		onRename(speaker, finalName);
		// Save voice embedding
		const emb = embeddings?.[speaker] || embeddings?.[current];
		if (emb) {
			try {
				await voicesApi.save(finalName, emb);
				showToast(`Saved voice: ${finalName}`);
			} catch {}
		}
	};

	let lastSpeaker = "";
	return (
		<div className={styles.container}>
			<div className={styles.hint}>Click to rename · Right-click to merge with another speaker</div>
			<div className={styles.chips}>
				{speakers.map((s) => (
					<div
						key={s}
						className={styles.chip}
						title="Click to rename · Right-click to merge"
						onClick={() => handleRename(s)}
						onContextMenu={(e) => {
							e.preventDefault();
							setMergeMenu({ x: e.clientX, y: e.clientY, speaker: s });
						}}
					>
						<span className={styles.chipDot} style={{ background: colorMap[s] }} />
						<span>{speakerNames[s] || s}</span>
					</div>
				))}
			</div>
			{segments.map((seg, i) => {
				const showHeader = seg.speaker !== lastSpeaker;
				lastSpeaker = seg.speaker;
				const displayName = speakerNames[seg.speaker] || seg.speaker;
				const color = colorMap[seg.speaker] || "#94A3B8";
				return (
					<div key={i}>
						{showHeader && (
							<div className={styles.speakerHeader} style={{ color }}>
								{displayName}
							</div>
						)}
						<div className={styles.speakerLine}>
							<span>{seg.text}</span>
							{seg.overlap && (
								<span className={styles.overlapBadge} title="Overlapping speech detected">
									overlap
								</span>
							)}
						</div>
					</div>
				);
			})}

			{mergeMenu && (
				<SpeakerMergeMenu
					x={mergeMenu.x}
					y={mergeMenu.y}
					currentSpeaker={mergeMenu.speaker}
					speakers={speakers}
					speakerNames={speakerNames}
					onClose={() => setMergeMenu(null)}
					onMerge={(from, into) => {
						onMerge(from, into);
						setMergeMenu(null);
					}}
				/>
			)}
		</div>
	);
}

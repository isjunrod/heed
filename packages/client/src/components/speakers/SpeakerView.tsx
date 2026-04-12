import { useState, useMemo, useEffect, useRef } from "react";
import type { Segment } from "@heed/shared";
import { speakerColor } from "@/lib/colors.ts";
import { useUIStore } from "@/stores/ui.ts";
import { voicesApi } from "@/api/voices.ts";
import { SpeakerMergeMenu } from "./SpeakerMergeMenu.tsx";
import styles from "./SpeakerView.module.css";

/** Reveals text character by character with a typing effect. */
function TypewriterText({ text, speed = 20 }: { text: string; speed?: number }) {
	const [charCount, setCharCount] = useState(0);
	const textRef = useRef(text);

	useEffect(() => {
		// If the text changed (new segment replaced this one), show full immediately
		if (textRef.current !== text) {
			textRef.current = text;
			setCharCount(text.length);
			return;
		}
		if (charCount >= text.length) return;
		const timer = setTimeout(() => setCharCount((c) => c + 1), speed);
		return () => clearTimeout(timer);
	}, [charCount, text, speed]);

	// Reset when component mounts with new text
	useEffect(() => {
		setCharCount(0);
		textRef.current = text;
	}, [text]);

	return <>{text.slice(0, charCount)}</>;
}

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
		return (
			<div className={styles.placeholder}>
				<span className={styles.placeholderDot} />
				Listening...
			</div>
		);
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
				const isLast = i === segments.length - 1;
				return (
					<div key={i}>
						{showHeader && (
							<div className={styles.speakerHeader} style={{ color }}>
								{displayName}
							</div>
						)}
						<div className={`${styles.speakerLine} ${isLast ? styles.speakerLineTyping : ""}`}>
							{isLast ? <TypewriterText text={seg.text} speed={25} /> : seg.text}
							{isLast && <span className={styles.cursor} />}
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

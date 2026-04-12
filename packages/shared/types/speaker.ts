export interface Segment {
	speaker: string;
	start: number;
	end: number;
	text: string;
	/** True when this segment overlaps in time with a segment from a different channel (mic vs system). */
	overlap?: boolean;
	/** Source channel: "mic" (you) or "sys" (other party). Only set on dual-capture sessions. */
	channel?: "mic" | "sys";
}

export interface DiarizationResult {
	speakers: string[];
	speaker_count: number;
	segments: Segment[];
	text: string;
	embeddings?: Record<string, number[]>;
}

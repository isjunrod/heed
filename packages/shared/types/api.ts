// API request/response types

export interface HealthResponse {
	ollama: boolean;
	whisper: boolean;
	pyannote: boolean;
}

export interface TranscribeResult {
	success: true;
	text: string;
	files: { wav: string; srt: string; txt: string };
	metadata: { language: string; model: string };
	speakers: string[];
	segments: import("./speaker.ts").Segment[];
	embeddings?: Record<string, number[]>;
	wordCount: number;
	timing?: { total_ms: number };
}

export interface SystemRecordStartResponse {
	recording: boolean;
	mode: string;
	path: string;
	monitor: string | null;
	mic: string;
}

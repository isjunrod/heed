/**
 * Ollama model catalog types — shared between client and server.
 * The catalog itself lives in Python (transcription_server.py) and is
 * exposed via /api/models. The Bun server merges in install state + current selection.
 */
export type ModelQuality = "good" | "very_good" | "excellent" | "best";
export type ModelSpeed = "slow" | "medium" | "fast" | "very_fast";

export interface CatalogModel {
	id: string;
	name: string;
	vendor: string;
	size_mb: number; // download size
	vram_mb: number; // GPU footprint when loaded
	quality: ModelQuality;
	speed: ModelSpeed;
	description?: string;
	new?: boolean;
	gpu_compatible: boolean; // computed for THIS hardware
	recommended_runtime: "gpu" | "cpu";
	installed: boolean;
}

export interface CurrentModel {
	id?: string;
	num_gpu?: number; // 0 = CPU forced, undefined = Ollama auto
}

export interface ModelsResponse {
	gpu_available: boolean;
	gpu_name: string | null;
	total_vram_mb: number;
	free_vram_mb: number;
	pyannote_reserve_mb: number;
	safety_margin_mb: number;
	tier: "ultra" | "high" | "mid" | "low" | "cpu_only";
	default_model: string | null;
	models: CatalogModel[];
	current: CurrentModel;
}

/** Streamed event from /api/models/pull (mirrors Ollama's /api/pull stream). */
export interface PullProgress {
	status?: string;
	digest?: string;
	total?: number;
	completed?: number;
	error?: string;
	done?: boolean;
}

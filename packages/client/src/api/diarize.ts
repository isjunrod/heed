import type { DiarizationResult } from "@heed/shared";
import { apiClient } from "./client.ts";

export const diarizeApi = {
	run: (wavPath: string, srtPath?: string, minSpeakers?: number, maxSpeakers?: number) =>
		apiClient.post<DiarizationResult>("/api/diarize", {
			wavPath,
			srtPath,
			minSpeakers,
			maxSpeakers,
		}),
};

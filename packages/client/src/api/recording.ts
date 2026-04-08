import type { SystemRecordStartResponse } from "@heed/shared";
import { apiClient } from "./client.ts";

export const recordingApi = {
	start: (mode: "mic" | "system" | "both" = "both") =>
		apiClient.post<SystemRecordStartResponse>("/api/sysrecord/start", { mode }),
	stop: () => apiClient.post<{ path: string }>("/api/sysrecord/stop"),
	levelsUrl: () => "/api/sysrecord/levels",
};

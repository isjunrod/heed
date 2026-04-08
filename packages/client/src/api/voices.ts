import type { VoicesListResponse } from "@heed/shared";
import { apiClient } from "./client.ts";

export const voicesApi = {
	list: () => apiClient.get<VoicesListResponse>("/api/voices"),
	save: (name: string, embedding: number[]) =>
		apiClient.post<{ ok: boolean; name: string; total: number }>("/api/voices/save", { name, embedding }),
	delete: (name: string) =>
		apiClient.post<{ ok: boolean }>("/api/voices/delete", { name }),
};

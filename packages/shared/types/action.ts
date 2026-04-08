export interface ActionItem {
	id: string;
	sessionId: string;
	sessionTitle: string;
	sessionDate: string;
	lineIdx: number;
	done: boolean;
	text: string;
}

export type ActionFilter = "open" | "done" | "all";

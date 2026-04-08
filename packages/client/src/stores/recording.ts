import { create } from "zustand";
import type { Segment, TranscribeResult } from "@heed/shared";

interface RecordingState {
	recording: boolean;
	processing: boolean;
	seconds: number;
	processStep: string;
	processProgress: number;

	// Result of last recording
	transcript: string;
	segments: Segment[];
	speakers: string[];
	embeddings: Record<string, number[]>;
	files: TranscribeResult["files"] | null;
	notesText: string;
	currentSessionId: string | null;

	// Mutators
	startRecording: () => void;
	tick: () => void;
	stopRecording: () => void;
	setProcessing: (step: string, percent: number) => void;
	setResult: (result: TranscribeResult) => void;
	setNotes: (text: string) => void;
	setSessionId: (id: string | null) => void;
	reset: () => void;
}

export const useRecordingStore = create<RecordingState>((set) => ({
	recording: false,
	processing: false,
	seconds: 0,
	processStep: "",
	processProgress: 0,

	transcript: "",
	segments: [],
	speakers: [],
	embeddings: {},
	files: null,
	notesText: "",
	currentSessionId: null,

	startRecording: () =>
		set({
			recording: true,
			seconds: 0,
			processing: false,
			transcript: "",
			segments: [],
			speakers: [],
			embeddings: {},
			files: null,
			notesText: "",
			currentSessionId: null,
		}),

	tick: () => set((s) => ({ seconds: s.seconds + 1 })),

	stopRecording: () => set({ recording: false, processing: true, processStep: "Processing...", processProgress: 0 }),

	setProcessing: (step, percent) => set({ processStep: step, processProgress: percent }),

	setResult: (result) =>
		set({
			processing: false,
			transcript: result.text,
			segments: result.segments || [],
			speakers: result.speakers || [],
			embeddings: result.embeddings || {},
			files: result.files,
			processProgress: 100,
		}),

	setNotes: (text) => set({ notesText: text }),

	setSessionId: (id) => set({ currentSessionId: id }),

	reset: () =>
		set({
			recording: false,
			processing: false,
			seconds: 0,
			transcript: "",
			segments: [],
			speakers: [],
			embeddings: {},
			files: null,
			notesText: "",
			currentSessionId: null,
		}),
}));

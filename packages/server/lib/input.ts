/**
 * Input validation: detects URLs vs file paths and rejects unsafe input.
 */
import { existsSync } from "node:fs";

const SUPPORTED_EXTENSIONS = [
	".mp3", ".mp4", ".m4a", ".wav", ".webm", ".ogg",
	".flac", ".mkv", ".mov", ".avi", ".aac", ".opus",
];

export type InputType = "url" | "file";

export interface ParsedInput {
	type: InputType;
	value: string;
}

function rejectControlChars(input: string): string {
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		// Allow tab, LF, CR
		if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
			throw new Error(`Input contains a control character at position ${i}`);
		}
	}
	return input;
}

export function validateUrl(raw: string): string {
	const cleaned = rejectControlChars(raw.trim());
	if (!/^https?:\/\//i.test(cleaned)) {
		throw new Error(`URL must start with http:// or https://`);
	}
	if (cleaned.includes("..")) {
		throw new Error(`URL contains path traversal`);
	}
	return cleaned;
}

export function validateFilePath(raw: string): string {
	const cleaned = rejectControlChars(raw.trim());
	if (cleaned.includes("..")) {
		throw new Error(`Path contains traversal (..)`);
	}
	if (/%[0-9a-f]{2}/i.test(cleaned)) {
		throw new Error(`Path contains URL-encoded characters`);
	}
	if (!existsSync(cleaned)) {
		throw new Error(`File not found: ${cleaned}`);
	}
	const ext = cleaned.slice(cleaned.lastIndexOf(".")).toLowerCase();
	if (!SUPPORTED_EXTENSIONS.includes(ext)) {
		throw new Error(`Unsupported file extension: ${ext}`);
	}
	return cleaned;
}

export function parseInput(raw: string): ParsedInput {
	const cleaned = rejectControlChars(raw.trim());
	if (/^https?:\/\//i.test(cleaned)) {
		return { type: "url", value: validateUrl(cleaned) };
	}
	return { type: "file", value: validateFilePath(cleaned) };
}

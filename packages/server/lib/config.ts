/**
 * Application configuration and storage paths.
 * Stores user settings in ~/.heed-app/
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
	language: string;
	modelSize: string;
	diarizationEnabled: boolean;
}

const APP_DIR = join(homedir(), ".heed-app");
const CONFIG_PATH = join(APP_DIR, "config.json");
const NOTES_DIR = join(APP_DIR, "notes");

const DEFAULTS: AppConfig = {
	language: "auto",
	modelSize: "small",
	diarizationEnabled: false,
};

export function getAppDir(): string {
	return APP_DIR;
}

export function getNotesDir(): string {
	return NOTES_DIR;
}

export function ensureDirs(): void {
	for (const dir of [APP_DIR, NOTES_DIR]) {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}
}

export function readConfig(): AppConfig {
	ensureDirs();
	if (!existsSync(CONFIG_PATH)) {
		writeConfig(DEFAULTS);
		return { ...DEFAULTS };
	}
	try {
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		return { ...DEFAULTS, ...saved };
	} catch {
		return { ...DEFAULTS };
	}
}

export function writeConfig(config: Partial<AppConfig>): AppConfig {
	ensureDirs();
	const current = existsSync(CONFIG_PATH)
		? JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
		: {};
	const merged = { ...DEFAULTS, ...current, ...config };
	writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
	return merged;
}

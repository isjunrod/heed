/**
 * FileSystem-based storage implementation.
 * Stores everything as JSON files under ~/.heed-app/
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session, SessionPatch, Template, Voice } from "@heed/shared";
import type { SessionStore, TemplateStore, VoiceStore, StorageBundle } from "./index.ts";

function ensureDir(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function readJsonSafe<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

// --- SessionStore ---
class FsSessionStore implements SessionStore {
	constructor(private dir: string) { ensureDir(dir); }

	async list(): Promise<Session[]> {
		const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
		const sessions = files
			.map((f) => readJsonSafe<Session>(join(this.dir, f)))
			.filter((s): s is Session => s !== null)
			.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		return sessions;
	}

	async get(id: string): Promise<Session | null> {
		const path = join(this.dir, `${id}.json`);
		if (!existsSync(path)) return null;
		return readJsonSafe<Session>(path);
	}

	async create(session: Session): Promise<Session> {
		const id = session.id || `session-${Date.now()}`;
		const now = new Date().toISOString();
		const data: Session = {
			...session,
			id,
			createdAt: session.createdAt || now,
			updatedAt: now,
		};
		writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(data, null, 2));
		return data;
	}

	async update(id: string, patch: SessionPatch): Promise<Session | null> {
		const existing = await this.get(id);
		if (!existing) return null;
		const merged: Session = {
			...existing,
			...patch,
			updatedAt: new Date().toISOString(),
		};
		writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(merged, null, 2));
		return merged;
	}

	async delete(id: string): Promise<boolean> {
		const path = join(this.dir, `${id}.json`);
		if (!existsSync(path)) return false;
		unlinkSync(path);
		return true;
	}
}

// --- TemplateStore ---
class FsTemplateStore implements TemplateStore {
	constructor(private dir: string) { ensureDir(dir); }

	async list(): Promise<Template[]> {
		const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
		const templates = files
			.map((f) => readJsonSafe<Template>(join(this.dir, f)))
			.filter((t): t is Template => t !== null)
			.sort((a, b) => {
				if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
				return (a.name || "").localeCompare(b.name || "");
			});
		return templates;
	}

	async get(id: string): Promise<Template | null> {
		return readJsonSafe<Template>(join(this.dir, `${id}.json`));
	}

	async save(template: Template): Promise<Template> {
		const id = template.id || `custom-${Date.now()}`;
		const data = { ...template, id };
		writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(data, null, 2));
		return data;
	}

	async delete(id: string): Promise<boolean> {
		const path = join(this.dir, `${id}.json`);
		if (!existsSync(path)) return false;
		const tpl = readJsonSafe<Template>(path);
		if (tpl?.isDefault) return false;
		unlinkSync(path);
		return true;
	}

	async seed(defaults: Template[]): Promise<void> {
		for (const t of defaults) {
			const path = join(this.dir, `${t.id}.json`);
			if (!existsSync(path)) writeFileSync(path, JSON.stringify(t, null, 2));
		}
	}
}

// --- VoiceStore ---
class FsVoiceStore implements VoiceStore {
	constructor(private path: string) {
		const dir = this.path.substring(0, this.path.lastIndexOf("/"));
		ensureDir(dir);
	}

	private read(): Record<string, number[]> {
		if (!existsSync(this.path)) return {};
		try {
			return JSON.parse(readFileSync(this.path, "utf-8"));
		} catch {
			return {};
		}
	}

	private write(data: Record<string, number[]>): void {
		writeFileSync(this.path, JSON.stringify(data, null, 2));
	}

	async list(): Promise<string[]> {
		return Object.keys(this.read());
	}

	async all(): Promise<Record<string, number[]>> {
		return this.read();
	}

	async save(name: string, embedding: number[]): Promise<void> {
		const data = this.read();
		data[name] = embedding;
		this.write(data);
	}

	async delete(name: string): Promise<boolean> {
		const data = this.read();
		if (!(name in data)) return false;
		delete data[name];
		this.write(data);
		return true;
	}
}

// --- Factory ---
export function createFilesystemStorage(appDir: string): StorageBundle {
	return {
		sessions: new FsSessionStore(join(appDir, "sessions")),
		templates: new FsTemplateStore(join(appDir, "templates")),
		voices: new FsVoiceStore(join(appDir, "voices.json")),
	};
}

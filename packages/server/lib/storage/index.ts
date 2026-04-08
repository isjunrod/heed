import type { Session, SessionPatch, Template, Voice } from "@heed/shared";

/**
 * Session storage abstraction.
 * V1 implementation: filesystem (one JSON per session in ~/.heed-app/sessions/)
 * V2 implementation: Postgres (cloud, multi-tenant) — not implemented yet
 */
export interface SessionStore {
	list(): Promise<Session[]>;
	get(id: string): Promise<Session | null>;
	create(session: Session): Promise<Session>;
	update(id: string, patch: SessionPatch): Promise<Session | null>;
	delete(id: string): Promise<boolean>;
}

export interface TemplateStore {
	list(): Promise<Template[]>;
	get(id: string): Promise<Template | null>;
	save(template: Template): Promise<Template>;
	delete(id: string): Promise<boolean>;
	seed(defaults: Template[]): Promise<void>;
}

export interface VoiceStore {
	list(): Promise<string[]>;
	all(): Promise<Record<string, number[]>>;
	save(name: string, embedding: number[]): Promise<void>;
	delete(name: string): Promise<boolean>;
}

export interface StorageBundle {
	sessions: SessionStore;
	templates: TemplateStore;
	voices: VoiceStore;
}

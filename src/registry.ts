import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServiceAllocation {
	type: "http" | "tcp";
	port: number;
	/** Only set for http services. */
	domain?: string;
	/** Custom env var name requested via `--service name:type:ENV_VAR`. */
	envVar?: string;
}

export interface SessionEntry {
	project: string;
	session: string;
	worktree: string;
	createdAt: string;
	services: Record<string, ServiceAllocation>;
}

/** Keyed by `${project}/${session}`. */
export type Registry = Record<string, SessionEntry>;

export function stateDir(): string {
	return process.env.PORTERO_STATE_DIR ?? join(homedir(), ".local", "state", "portero");
}

export function registryPath(): string {
	return join(stateDir(), "registry.json");
}

export function caddyfilePath(): string {
	return join(stateDir(), "Caddyfile");
}

export function readRegistry(): Registry {
	if (!existsSync(registryPath())) return {};
	return JSON.parse(readFileSync(registryPath(), "utf8"));
}

export function writeRegistry(registry: Registry): void {
	mkdirSync(stateDir(), { recursive: true });
	writeFileSync(registryPath(), `${JSON.stringify(registry, null, "\t")}\n`);
}

const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 100;

/**
 * Serialize registry mutations across concurrent portero invocations
 * (e.g. two worktree setup scripts claiming at the same time).
 */
export async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
	const lockDir = join(stateDir(), "lock");
	mkdirSync(stateDir(), { recursive: true });
	for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
		try {
			mkdirSync(lockDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await Bun.sleep(LOCK_RETRY_MS);
			continue;
		}
		try {
			return await fn();
		} finally {
			rmSync(lockDir, { recursive: true, force: true });
		}
	}
	throw new Error(`could not acquire registry lock — remove ${join(stateDir(), "lock")} if stale`);
}

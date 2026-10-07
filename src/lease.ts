import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./registry";

/**
 * Leases: exclusive, machine-wide ownership of a singleton resource (the iOS
 * simulator, a physical device, Metro's default port…) shared by parallel
 * agents. One holder at a time, a FIFO queue of waiters, and automatic
 * reclaim when the holder's agent dies or stops renewing.
 */

export interface Holder {
	/** Identity: the worktree path, or an explicit `--holder`. Same id = same holder (re-acquire renews). */
	id: string;
	worktree: string;
	/** Coding agent (claude/codex) that owns the holder; the lease dies with it. */
	agentPid?: number;
}

export interface Lease {
	resource: string;
	holder: Holder;
	note?: string;
	acquiredAt: string;
	renewedAt: string;
	ttlSeconds: number;
	/** Processes started under the lease (e.g. Metro); killed on release or reclaim. */
	pids: number[];
}

export interface Waiter {
	holder: Holder;
	note?: string;
	since: string;
	/** Waiters poll; one that stops polling (Ctrl-C, crashed) drops out of the queue. */
	lastSeen: string;
}

export interface LeaseState {
	leases: Record<string, Lease>;
	queues: Record<string, Waiter[]>;
}

export const DEFAULT_TTL_SECONDS = 45 * 60;
export const WAITER_STALE_MS = 30_000;

export function leasesPath(): string {
	return join(stateDir(), "leases.json");
}

export function readLeases(): LeaseState {
	if (!existsSync(leasesPath())) return { leases: {}, queues: {} };
	const state = JSON.parse(readFileSync(leasesPath(), "utf8")) as Partial<LeaseState>;
	return { leases: state.leases ?? {}, queues: state.queues ?? {} };
}

export function writeLeases(state: LeaseState): void {
	mkdirSync(stateDir(), { recursive: true });
	writeFileSync(leasesPath(), `${JSON.stringify(state, null, "\t")}\n`);
}

export interface Env {
	now: number;
	isAlive: (pid: number) => boolean;
}

export function expiresAt(lease: Lease): number {
	return Date.parse(lease.renewedAt) + lease.ttlSeconds * 1000;
}

/** Why a lease no longer binds anyone, or undefined if its holder still owns it. */
export function staleReason(lease: Lease, env: Env): string | undefined {
	if (lease.holder.agentPid !== undefined && !env.isAlive(lease.holder.agentPid)) {
		return `agent ${lease.holder.agentPid} exited`;
	}
	if (env.now >= expiresAt(lease)) return "ttl expired without renewal";
	return undefined;
}

function waiterLive(waiter: Waiter, env: Env): boolean {
	if (waiter.holder.agentPid !== undefined && !env.isAlive(waiter.holder.agentPid)) return false;
	return env.now - Date.parse(waiter.lastSeen) < WAITER_STALE_MS;
}

export type AcquireResult =
	| { kind: "granted"; lease: Lease; renewed: boolean; reclaimed?: Lease; reclaimReason?: string; waiting: number }
	| { kind: "busy"; lease?: Lease; position: number; waiting: Waiter[] };

export interface AcquireRequest {
	resource: string;
	holder: Holder;
	ttlSeconds: number;
	note?: string;
	/** Join the queue when busy (set by `--wait`); otherwise a busy result leaves no trace. */
	enqueue: boolean;
}

/**
 * Pure state transition for one acquire attempt. The caller persists `state`
 * and kills `reclaimed.pids` (the dead holder's Metro etc.) outside the lock.
 */
export function tryAcquire(state: LeaseState, req: AcquireRequest, env: Env): AcquireResult {
	const { resource, holder } = req;
	const nowIso = new Date(env.now).toISOString();
	const queue = (state.queues[resource] ?? []).filter((w) => w.holder.id === holder.id || waiterLive(w, env));
	state.queues[resource] = queue;

	let current: Lease | undefined = state.leases[resource];
	let reclaimed: Lease | undefined;
	let reclaimReason: string | undefined;
	if (current) {
		reclaimReason = staleReason(current, env);
		if (reclaimReason && current.holder.id !== holder.id) {
			reclaimed = current;
			delete state.leases[resource];
			current = undefined;
		}
	}

	const othersWaiting = () => queue.filter((w) => w.holder.id !== holder.id).length;

	if (current && current.holder.id === holder.id) {
		current.renewedAt = nowIso;
		current.ttlSeconds = req.ttlSeconds;
		current.holder.agentPid = holder.agentPid ?? current.holder.agentPid;
		if (req.note) current.note = req.note;
		state.queues[resource] = queue.filter((w) => w.holder.id !== holder.id);
		return { kind: "granted", lease: current, renewed: true, waiting: othersWaiting() };
	}

	const head = queue[0];
	const myTurn = !current && (!head || head.holder.id === holder.id);
	if (myTurn) {
		const lease: Lease = {
			resource,
			holder,
			note: req.note,
			acquiredAt: nowIso,
			renewedAt: nowIso,
			ttlSeconds: req.ttlSeconds,
			pids: [],
		};
		state.leases[resource] = lease;
		state.queues[resource] = queue.filter((w) => w.holder.id !== holder.id);
		return { kind: "granted", lease, renewed: false, reclaimed, reclaimReason, waiting: othersWaiting() };
	}

	const mine = queue.find((w) => w.holder.id === holder.id);
	if (mine) {
		mine.lastSeen = nowIso;
		if (req.note) mine.note = req.note;
	} else if (req.enqueue) {
		queue.push({ holder, note: req.note, since: nowIso, lastSeen: nowIso });
	}
	const index = queue.findIndex((w) => w.holder.id === holder.id);
	return {
		kind: "busy",
		lease: current,
		position: index === -1 ? queue.length + 1 : index + 1,
		waiting: queue,
	};
}

/** Drop a waiter (e.g. `--wait` timed out or was interrupted). */
export function leaveQueue(state: LeaseState, resource: string, holderId: string): void {
	const queue = state.queues[resource];
	if (queue) state.queues[resource] = queue.filter((w) => w.holder.id !== holderId);
}

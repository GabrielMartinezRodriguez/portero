import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
	type AcquireResult,
	DEFAULT_TTL_SECONDS,
	type Env,
	expiresAt,
	type Holder,
	type Lease,
	leaveQueue,
	readLeases,
	staleReason,
	tryAcquire,
	writeLeases,
} from "./lease";
import { sanitizeLabel } from "./naming";
import { findAgentPid, isAlive, killTrees } from "./procs";
import { withLock } from "./registry";

export const LEASE_HELP = `portero lease — exclusive, machine-wide turns on a singleton resource

Usage:
  portero lease acquire <resource> [--wait [--timeout 20m]] [--ttl 45m] [--note "why"] [--json]
        Take the resource, or renew it if this worktree already holds it.
        Busy → exit 3 with the holder and queue (or, with --wait, queue up FIFO
        and block until it is your turn; exit 4 on timeout).
  portero lease release <resource> [--force]
        Give it back. Kills every process attached to the lease.
  portero lease attach <resource> <pid>...
        Tie processes (e.g. Metro) to your lease: they die when it is released
        or reclaimed, so nobody inherits your stale bundler.
  portero lease run <resource> [--wait] [--ttl 45m] [--note ".."] -- <command...>
        acquire → run → release, renewing while the command runs.
  portero lease status [<resource>] [--json]

Holder = the current git worktree (override with --holder). The lease also
records the coding agent (claude/codex) that asked for it: if that agent exits,
or the lease is not renewed within its TTL, the next acquire reclaims it and
kills its attached processes.

Exit codes: 0 ok · 3 busy · 4 wait timed out · 1 error
`;

function die(message: string, code = 1): never {
	console.error(`portero: ${message}`);
	process.exit(code);
}

export function parseDuration(raw: string): number {
	const match = raw.trim().match(/^(\d+)\s*(s|m|h)?$/);
	if (!match) throw new Error(`invalid duration "${raw}" (use 90s, 45m, 2h)`);
	const value = Number(match[1]);
	return value * { s: 1, m: 60, h: 3600 }[(match[2] ?? "s") as "s" | "m" | "h"];
}

function formatAge(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 90) return `${s}s`;
	if (s < 5400) return `${Math.round(s / 60)}m`;
	return `${(s / 3600).toFixed(1)}h`;
}

function shortenPath(path: string): string {
	return path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
}

async function gitToplevel(cwd: string): Promise<string> {
	const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" });
	const out = (await new Response(proc.stdout).text()).trim();
	return (await proc.exited) === 0 && out ? out : cwd;
}

async function resolveHolder(explicit?: string): Promise<Holder> {
	const worktree = await gitToplevel(process.cwd());
	return { id: explicit ?? worktree, worktree, agentPid: await findAgentPid() };
}

function realEnv(): Env {
	return { now: Date.now(), isAlive };
}

function describeLease(lease: Lease, env: Env): string {
	const who = lease.holder.id === lease.holder.worktree ? shortenPath(lease.holder.worktree) : lease.holder.id;
	const agent = lease.holder.agentPid ? `agent ${lease.holder.agentPid}` : "no agent";
	const note = lease.note ? ` — "${lease.note}"` : "";
	const left = formatAge(expiresAt(lease) - env.now);
	return `${who} (${agent}, held ${formatAge(env.now - Date.parse(lease.acquiredAt))}, expires in ${left})${note}`;
}

async function attempt(
	resource: string,
	holder: Holder,
	ttlSeconds: number,
	note: string | undefined,
	enqueue: boolean,
): Promise<AcquireResult> {
	const result = await withLock(() => {
		const state = readLeases();
		const res = tryAcquire(state, { resource, holder, ttlSeconds, note, enqueue }, realEnv());
		writeLeases(state);
		return res;
	});
	if (result.kind === "granted" && result.reclaimed) {
		const killed = await killTrees(result.reclaimed.pids);
		console.error(
			`portero: reclaimed ${resource} from ${shortenPath(result.reclaimed.holder.worktree)} (${result.reclaimReason})` +
				(killed.length ? `, killed ${killed.length} attached process(es)` : ""),
		);
	}
	return result;
}

async function acquire(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			wait: { type: "boolean" },
			timeout: { type: "string" },
			ttl: { type: "string" },
			note: { type: "string" },
			holder: { type: "string" },
			json: { type: "boolean" },
		},
	});
	const resource = positionals[0] ? sanitizeLabel(positionals[0]) : die("acquire needs a <resource>");
	const holder = await resolveHolder(values.holder);
	const ttl = values.ttl ? parseDuration(values.ttl) : DEFAULT_TTL_SECONDS;
	const lease = await acquireLoop(resource, holder, ttl, values.note, values.wait ?? false, values.timeout, values.json);
	if (values.json) console.log(JSON.stringify(lease, null, "\t"));
}

async function acquireLoop(
	resource: string,
	holder: Holder,
	ttl: number,
	note: string | undefined,
	wait: boolean,
	timeout: string | undefined,
	quiet = false,
): Promise<Lease> {
	const deadline = timeout ? Date.now() + parseDuration(timeout) * 1000 : Number.POSITIVE_INFINITY;
	let announced = -1;
	const leave = async () => {
		await withLock(() => {
			const state = readLeases();
			leaveQueue(state, resource, holder.id);
			writeLeases(state);
		});
	};
	const onSignal = () => {
		leave().finally(() => process.exit(130));
	};
	if (wait) {
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
	}
	try {
		for (;;) {
			const result = await attempt(resource, holder, ttl, note, wait);
			if (result.kind === "granted") {
				if (!quiet) {
					const verb = result.renewed ? "renewed" : "acquired";
					const queue = result.waiting ? ` — ${result.waiting} agent(s) waiting: release as soon as you are done` : "";
					console.log(`${verb} ${resource} for ${formatAge(ttl * 1000)}${queue}`);
				}
				return result.lease;
			}
			const env = realEnv();
			const holderText = result.lease ? describeLease(result.lease, env) : "the agent ahead of you in the queue";
			if (!wait) {
				console.error(`portero: ${resource} is busy — held by ${holderText}`);
				if (result.waiting.length) console.error(`portero: ${result.waiting.length} already waiting`);
				console.error(`portero: retry with --wait to queue up, or do work that does not need ${resource} first`);
				process.exit(3);
			}
			if (result.position !== announced) {
				console.error(`portero: waiting for ${resource} (position ${result.position}) — held by ${holderText}`);
				announced = result.position;
			}
			if (Date.now() >= deadline) {
				await leave();
				die(`timed out waiting for ${resource}`, 4);
			}
			await Bun.sleep(2000);
		}
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

async function releaseLease(resource: string, holderId: string, force: boolean): Promise<void> {
	const lease = await withLock(() => {
		const state = readLeases();
		const current = state.leases[resource];
		if (!current) return undefined;
		if (current.holder.id !== holderId && !force) {
			die(`${resource} is held by ${shortenPath(current.holder.worktree)}, not you — pass --force to take it away`);
		}
		delete state.leases[resource];
		writeLeases(state);
		return current;
	});
	if (!lease) {
		console.log(`${resource} was not held`);
		return;
	}
	const killed = await killTrees(lease.pids);
	console.log(`released ${resource}${killed.length ? `, killed ${killed.length} attached process(es)` : ""}`);
}

async function release(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { force: { type: "boolean" }, holder: { type: "string" } },
	});
	const resource = positionals[0] ? sanitizeLabel(positionals[0]) : die("release needs a <resource>");
	const holder = await resolveHolder(values.holder);
	await releaseLease(resource, holder.id, values.force ?? false);
}

async function attach(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { holder: { type: "string" } },
	});
	const [rawResource, ...rawPids] = positionals;
	if (!rawResource || rawPids.length === 0) die("attach needs <resource> <pid>...");
	const resource = sanitizeLabel(rawResource);
	const pids = rawPids.map((p) => (/^\d+$/.test(p) ? Number(p) : die(`invalid pid "${p}"`)));
	const holder = await resolveHolder(values.holder);
	await withLock(() => {
		const state = readLeases();
		const lease = state.leases[resource];
		if (!lease || lease.holder.id !== holder.id) die(`you do not hold ${resource} — acquire it first`);
		lease.pids = [...new Set([...lease.pids, ...pids])];
		writeLeases(state);
	});
	console.log(`attached ${pids.join(", ")} to ${resource}`);
}

async function run(args: string[]): Promise<void> {
	const split = args.indexOf("--");
	if (split === -1 || split === args.length - 1) die("run needs `-- <command...>`");
	const { values, positionals } = parseArgs({
		args: args.slice(0, split),
		allowPositionals: true,
		options: {
			wait: { type: "boolean" },
			timeout: { type: "string" },
			ttl: { type: "string" },
			note: { type: "string" },
			holder: { type: "string" },
		},
	});
	const resource = positionals[0] ? sanitizeLabel(positionals[0]) : die("run needs a <resource>");
	const command = args.slice(split + 1);
	const holder = await resolveHolder(values.holder);
	const ttl = values.ttl ? parseDuration(values.ttl) : DEFAULT_TTL_SECONDS;
	const alreadyHeld = readLeases().leases[resource]?.holder.id === holder.id;
	await acquireLoop(resource, holder, ttl, values.note, values.wait ?? false, values.timeout);

	const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	const renew = setInterval(
		() => {
			attempt(resource, holder, ttl, values.note, false).catch(() => {});
		},
		Math.max(5_000, (ttl * 1000) / 3),
	);
	const code = await child.exited;
	clearInterval(renew);
	// A lease the caller already held (e.g. Metro attached to it) is theirs to release.
	if (!alreadyHeld) await releaseLease(resource, holder.id, false);
	process.exit(code);
}

async function status(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { json: { type: "boolean" } },
	});
	const state = readLeases();
	const env = realEnv();
	const filter = positionals[0] ? sanitizeLabel(positionals[0]) : undefined;
	const resources = [...new Set([...Object.keys(state.leases), ...Object.keys(state.queues)])]
		.filter((r) => !filter || r === filter)
		.sort();
	if (values.json) {
		const out = Object.fromEntries(
			resources.map((r) => {
				const lease = state.leases[r];
				return [
					r,
					{
						lease: lease ? { ...lease, stale: staleReason(lease, env) ?? null } : null,
						queue: state.queues[r] ?? [],
					},
				];
			}),
		);
		console.log(JSON.stringify(out, null, "\t"));
		return;
	}
	if (resources.length === 0) {
		console.log(filter ? `${filter}: free` : "no leases");
		return;
	}
	for (const r of resources) {
		const lease = state.leases[r];
		const stale = lease ? staleReason(lease, env) : undefined;
		if (!lease) console.log(`${r}: free`);
		else if (stale) console.log(`${r}: free (last holder ${shortenPath(lease.holder.worktree)}: ${stale})`);
		else console.log(`${r}: held by ${describeLease(lease, env)}`);
		if (lease?.pids.length) console.log(`  attached: ${lease.pids.map((p) => `${p}${isAlive(p) ? "" : " (dead)"}`).join(", ")}`);
		const queue = state.queues[r] ?? [];
		queue.forEach((w, i) => {
			const note = w.note ? ` — "${w.note}"` : "";
			console.log(`  ${i + 1}. waiting ${formatAge(env.now - Date.parse(w.since))}: ${shortenPath(w.holder.worktree)}${note}`);
		});
	}
}

export async function leaseCommand(args: string[]): Promise<void> {
	const [sub, ...rest] = args;
	switch (sub) {
		case "acquire":
		case "renew":
			return acquire(rest);
		case "release":
			return release(rest);
		case "attach":
			return attach(rest);
		case "run":
			return run(rest);
		case "status":
		case "ls":
			return status(rest);
		case undefined:
		case "help":
		case "--help":
		case "-h":
			console.log(LEASE_HELP);
			return;
		default:
			die(`unknown lease command "${sub}" — run \`portero lease help\``);
	}
}

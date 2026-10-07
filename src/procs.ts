/**
 * Process helpers for leases: find the coding agent that owns this shell,
 * check liveness, and tear down process trees attached to a lease.
 */

interface ProcRow {
	pid: number;
	ppid: number;
	command: string;
}

async function psTable(): Promise<ProcRow[]> {
	const proc = Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,comm="], { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	const rows: ProcRow[] = [];
	for (const line of out.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
		if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
	}
	return rows;
}

/**
 * Claude Code runs as `claude` or as its versioned binary
 * (`~/.local/share/claude/versions/2.1.292`); Codex runs as `codex`.
 */
export function isAgentCommand(command: string): boolean {
	const name = command.split("/").pop() ?? command;
	return name === "claude" || name === "codex" || /\/claude\/versions\//.test(command);
}

/**
 * Pid of the nearest coding-agent ancestor of `pid`, if any. A lease held by an
 * agent dies with the agent, so a crashed or closed session never blocks the
 * resource until its TTL runs out.
 */
export async function findAgentPid(pid: number = process.pid): Promise<number | undefined> {
	const table = new Map((await psTable()).map((row) => [row.pid, row]));
	let current = table.get(pid);
	for (let depth = 0; current && depth < 64; depth++) {
		if (isAgentCommand(current.command)) return current.pid;
		current = table.get(current.ppid);
	}
	return undefined;
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: exists but owned by someone else — still alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function descendants(roots: number[]): Promise<number[]> {
	const children = new Map<number, number[]>();
	for (const row of await psTable()) {
		const list = children.get(row.ppid) ?? [];
		list.push(row.pid);
		children.set(row.ppid, list);
	}
	const seen = new Set<number>();
	const stack = [...roots];
	while (stack.length > 0) {
		const pid = stack.pop() as number;
		if (seen.has(pid)) continue;
		seen.add(pid);
		stack.push(...(children.get(pid) ?? []));
	}
	return [...seen];
}

/**
 * SIGTERM `pids` and every descendant (Metro spawns worker trees), then
 * SIGKILL whatever is still alive after `graceMs`. Returns the pids signalled.
 */
export async function killTrees(pids: number[], graceMs = 2000): Promise<number[]> {
	const targets = (await descendants(pids.filter(isAlive))).filter((pid) => pid !== process.pid);
	for (const pid of targets) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline && targets.some(isAlive)) await Bun.sleep(100);
	for (const pid of targets.filter(isAlive)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	return targets;
}

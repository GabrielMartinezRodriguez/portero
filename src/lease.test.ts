import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Env, type Holder, type LeaseState, readLeases, tryAcquire, WAITER_STALE_MS, writeLeases } from "./lease";
import { parseDuration } from "./leaseCli";
import { isAgentCommand, isAlive, killTrees } from "./procs";

const T0 = Date.parse("2026-10-07T10:00:00Z");
const fresh = (): LeaseState => ({ leases: {}, queues: {} });
const holder = (name: string, agentPid?: number): Holder => ({ id: `/wt/${name}`, worktree: `/wt/${name}`, agentPid });
const env = (now = T0, dead: number[] = []): Env => ({ now, isAlive: (pid) => !dead.includes(pid) });
const req = (h: Holder, enqueue = false, ttlSeconds = 600) => ({ resource: "ios-sim", holder: h, ttlSeconds, enqueue });

describe("tryAcquire", () => {
	test("grants a free resource", () => {
		const state = fresh();
		const res = tryAcquire(state, req(holder("a", 1)), env());
		expect(res.kind).toBe("granted");
		expect(state.leases["ios-sim"].holder.id).toBe("/wt/a");
	});

	test("same holder renews instead of failing", () => {
		const state = fresh();
		tryAcquire(state, req(holder("a", 1)), env());
		const res = tryAcquire(state, req(holder("a", 1)), env(T0 + 60_000));
		expect(res).toMatchObject({ kind: "granted", renewed: true });
		expect(state.leases["ios-sim"].renewedAt).toBe(new Date(T0 + 60_000).toISOString());
	});

	test("another holder is told it is busy and leaves no trace without enqueue", () => {
		const state = fresh();
		tryAcquire(state, req(holder("a", 1)), env());
		const res = tryAcquire(state, req(holder("b", 2)), env());
		expect(res.kind).toBe("busy");
		expect(state.queues["ios-sim"]).toEqual([]);
	});

	test("reclaims when the holder's agent has exited", () => {
		const state = fresh();
		tryAcquire(state, req(holder("a", 1)), env());
		state.leases["ios-sim"].pids = [4242];
		const res = tryAcquire(state, req(holder("b", 2)), env(T0, [1]));
		expect(res.kind).toBe("granted");
		if (res.kind !== "granted") throw new Error();
		expect(res.reclaimed?.pids).toEqual([4242]);
		expect(res.reclaimReason).toContain("agent 1 exited");
		expect(state.leases["ios-sim"].holder.id).toBe("/wt/b");
	});

	test("reclaims when the TTL ran out without renewal", () => {
		const state = fresh();
		tryAcquire(state, req(holder("a", 1), false, 60), env());
		const res = tryAcquire(state, req(holder("b", 2)), env(T0 + 61_000));
		expect(res).toMatchObject({ kind: "granted", reclaimReason: "ttl expired without renewal" });
	});

	test("FIFO: a released resource goes to the head of the queue, not to whoever asks first", () => {
		const state = fresh();
		tryAcquire(state, req(holder("a", 1)), env());
		tryAcquire(state, req(holder("b", 2), true), env(T0 + 1000));
		tryAcquire(state, req(holder("c", 3), true), env(T0 + 2000));
		delete state.leases["ios-sim"]; // a releases

		const jumper = tryAcquire(state, req(holder("c", 3), true), env(T0 + 3000));
		expect(jumper).toMatchObject({ kind: "busy", position: 2 });
		const head = tryAcquire(state, req(holder("b", 2), true), env(T0 + 3000));
		expect(head).toMatchObject({ kind: "granted", waiting: 1 });
		expect(state.queues["ios-sim"].map((w) => w.holder.id)).toEqual(["/wt/c"]);
	});

	test("a waiter that stopped polling drops out of the queue", () => {
		const state = fresh();
		tryAcquire(state, req(holder("a", 1)), env());
		tryAcquire(state, req(holder("b", 2), true), env());
		delete state.leases["ios-sim"];
		const res = tryAcquire(state, req(holder("c", 3)), env(T0 + WAITER_STALE_MS + 1));
		expect(res.kind).toBe("granted");
	});

	test("a waiter whose agent died drops out of the queue", () => {
		const state = fresh();
		tryAcquire(state, req(holder("a", 1)), env());
		tryAcquire(state, req(holder("b", 2), true), env());
		delete state.leases["ios-sim"];
		expect(tryAcquire(state, req(holder("c", 3)), env(T0 + 1000, [2])).kind).toBe("granted");
	});

	test("the holder hears how many agents are waiting when it renews", () => {
		const state = fresh();
		tryAcquire(state, req(holder("a", 1)), env());
		tryAcquire(state, req(holder("b", 2), true), env());
		expect(tryAcquire(state, req(holder("a", 1)), env(T0 + 1000))).toMatchObject({ kind: "granted", waiting: 1 });
	});

	test("resources are independent", () => {
		const state = fresh();
		tryAcquire(state, req(holder("a", 1)), env());
		const other = tryAcquire(state, { ...req(holder("b", 2)), resource: "android-emu" }, env());
		expect(other.kind).toBe("granted");
	});
});

describe("lease persistence", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "portero-lease-"));
		process.env.PORTERO_STATE_DIR = dir;
	});
	afterEach(() => {
		delete process.env.PORTERO_STATE_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	test("missing file reads as empty", () => {
		expect(readLeases()).toEqual({ leases: {}, queues: {} });
	});

	test("round-trips", () => {
		const state = fresh();
		tryAcquire(state, req(holder("a", 1)), env());
		writeLeases(state);
		expect(readLeases().leases["ios-sim"].holder.id).toBe("/wt/a");
	});
});

describe("procs", () => {
	test("recognises claude, its versioned binary, and codex", () => {
		expect(isAgentCommand("claude")).toBe(true);
		expect(isAgentCommand("/Users/x/.local/share/claude/versions/2.1.292")).toBe(true);
		expect(isAgentCommand("/opt/homebrew/bin/codex")).toBe(true);
		expect(isAgentCommand("node")).toBe(false);
		expect(isAgentCommand("/bin/zsh")).toBe(false);
	});

	test("killTrees kills a process and its children", async () => {
		const parent = Bun.spawn(["sh", "-c", "sleep 60 & sleep 60 & wait"], { stdout: "ignore" });
		await Bun.sleep(200);
		const killed = await killTrees([parent.pid], 1000);
		expect(killed.length).toBeGreaterThanOrEqual(3);
		await Bun.sleep(100);
		for (const pid of killed) expect(isAlive(pid)).toBe(false);
	});
});

describe("parseDuration", () => {
	test("units", () => {
		expect(parseDuration("90")).toBe(90);
		expect(parseDuration("45m")).toBe(2700);
		expect(parseDuration("2h")).toBe(7200);
	});
	test("rejects junk", () => {
		expect(() => parseDuration("soon")).toThrow();
	});
});

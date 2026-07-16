import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCaddyfile } from "./caddy";
import { envify, sanitizeLabel, serviceDomain } from "./naming";
import { allocatePort, isPortListening } from "./ports";
import { readRegistry, writeRegistry } from "./registry";
import { parseServiceSpec } from "./spec";

describe("sanitizeLabel", () => {
	test("lowercases and dashes non-alphanumerics", () => {
		expect(sanitizeLabel("Feature/GPS_Fix")).toBe("feature-gps-fix");
	});
	test("trims leading/trailing dashes", () => {
		expect(sanitizeLabel("--hello--")).toBe("hello");
	});
	test("caps at 63 chars", () => {
		expect(sanitizeLabel("a".repeat(80))).toHaveLength(63);
	});
	test("throws when nothing survives", () => {
		expect(() => sanitizeLabel("///")).toThrow();
	});
});

describe("envify", () => {
	test("screams", () => {
		expect(envify("back-office")).toBe("BACK_OFFICE");
	});
});

describe("serviceDomain", () => {
	test("composes service.session.project.test", () => {
		expect(serviceDomain("api", "gps-fix", "ginger")).toBe("api.gps-fix.ginger.test");
	});
});

describe("parseServiceSpec", () => {
	test("parses name:type", () => {
		expect(parseServiceSpec("api:http")).toEqual({ name: "api", type: "http", envVar: undefined });
	});
	test("parses custom env var", () => {
		expect(parseServiceSpec("db:tcp:MONGO_PORT")).toEqual({ name: "db", type: "tcp", envVar: "MONGO_PORT" });
	});
	test("rejects bad type", () => {
		expect(() => parseServiceSpec("db:udp")).toThrow("expected http or tcp");
	});
	test("rejects bad env var", () => {
		expect(() => parseServiceSpec("db:tcp:2BAD")).toThrow("invalid env var");
	});
	test("rejects extra segments", () => {
		expect(() => parseServiceSpec("a:tcp:X:Y")).toThrow("expected name:type");
	});
});

describe("ports", () => {
	test("allocatePort returns a free port and reserves it", async () => {
		const taken = new Set<number>();
		const port = await allocatePort(taken);
		expect(port).toBeGreaterThanOrEqual(20000);
		expect(port).toBeLessThanOrEqual(49151);
		expect(taken.has(port)).toBe(true);
	});
	test("isPortListening detects a loopback listener", async () => {
		const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		expect(await isPortListening(listener.port)).toBe(true);
		listener.stop(true);
		expect(await isPortListening(listener.port)).toBe(false);
	});
	test("isPortListening detects a wildcard (0.0.0.0) listener", async () => {
		// The bug this guards against: a bind() probe to 127.0.0.1 succeeds under
		// SO_REUSEADDR while a wildcard listener holds the port (vite --host,
		// docker-proxy), misreporting it as free.
		const listener = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });
		expect(await isPortListening(listener.port)).toBe(true);
		listener.stop(true);
	});
});

describe("registry + caddyfile", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "portero-test-"));
		process.env.PORTERO_STATE_DIR = dir;
	});
	afterEach(() => {
		delete process.env.PORTERO_STATE_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	test("round-trips the registry", () => {
		expect(readRegistry()).toEqual({});
		const registry = {
			"ginger/gps-fix": {
				project: "ginger",
				session: "gps-fix",
				worktree: "/tmp/wt",
				createdAt: "2026-07-16T00:00:00.000Z",
				services: { api: { type: "http" as const, port: 42311, domain: "api.gps-fix.ginger.test" } },
			},
		};
		writeRegistry(registry);
		expect(readRegistry()).toEqual(registry);
	});

	test("renders http services only, sorted", () => {
		const caddyfile = renderCaddyfile({
			"ginger/gps-fix": {
				project: "ginger",
				session: "gps-fix",
				worktree: "/tmp/wt",
				createdAt: "2026-07-16T00:00:00.000Z",
				services: {
					db: { type: "tcp", port: 42313 },
					api: { type: "http", port: 42311, domain: "api.gps-fix.ginger.test" },
				},
			},
		});
		expect(caddyfile).toContain("api.gps-fix.ginger.test {");
		expect(caddyfile).toContain("reverse_proxy 127.0.0.1:42311");
		expect(caddyfile).toContain("local_certs");
		expect(caddyfile).not.toContain("42313");
	});
});

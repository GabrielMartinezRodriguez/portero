#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { syncCaddy } from "./caddy";
import { leaseCommand } from "./leaseCli";
import { detectProject, detectSession, envify, sanitizeLabel, serviceDomain } from "./naming";
import { allocatePort, isPortListening } from "./ports";
import {
	readRegistry,
	type Registry,
	registryPath,
	type SessionEntry,
	withLock,
	writeRegistry,
} from "./registry";
import { setup } from "./setup";
import { parseServiceSpec } from "./spec";

const HELP = `portero ${pkg.version} — local port & domain allocator for parallel dev sessions

Usage:
  portero setup                          One-time macOS setup (dnsmasq + Caddy, needs sudo)
  portero claim --service name:type[:ENV_VAR] ...
                [--project X] [--name Y] [--env | --json | --dotenv PATH]
                                         Reserve ports (+ *.test domains for http services)
                                         for the current worktree. Idempotent.
  portero release [PROJECT/SESSION | SESSION] [--project X] [--all]
                                         Release one session (default: current worktree's),
                                         a whole project, or everything.
  portero ls [--json]                    List sessions, services, ports, domains, status
  portero gc                             Release sessions whose worktree no longer exists
  portero lease acquire|release|attach|run|status <resource> ...
                                         Exclusive turns on a singleton resource shared by
                                         parallel agents (e.g. the iOS simulator), with a
                                         FIFO queue. See \`portero lease help\`.

Service types: http (port + https://service.session.project.test) | tcp (port only).

Examples:
  eval "$(portero claim --project ginger --service api:http:PORT --service db:tcp:MONGO_PORT --env)"
  portero release --project ginger
  portero release --all
  portero lease acquire ios-sim --wait --note "maestro flow for onboarding"
`;

function die(message: string): never {
	console.error(`portero: ${message}`);
	process.exit(1);
}

function envPairs(entry: SessionEntry): Array<[string, string]> {
	const pairs: Array<[string, string]> = [
		["PORTERO_PROJECT", entry.project],
		["PORTERO_SESSION", entry.session],
	];
	for (const name of Object.keys(entry.services).sort()) {
		const service = entry.services[name];
		pairs.push([`PORTERO_PORT_${envify(name)}`, String(service.port)]);
		if (service.domain) pairs.push([`PORTERO_URL_${envify(name)}`, `https://${service.domain}`]);
		if (service.envVar) pairs.push([service.envVar, String(service.port)]);
	}
	return pairs;
}

function printEntry(entry: SessionEntry): void {
	console.log(`${entry.project}/${entry.session}  (${entry.worktree})`);
	for (const name of Object.keys(entry.services).sort()) {
		const service = entry.services[name];
		const target = service.domain ? `https://${service.domain}` : service.type;
		console.log(`  ${name.padEnd(12)} ${String(service.port).padEnd(6)} ${target}`);
	}
}

async function claim(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			project: { type: "string" },
			name: { type: "string" },
			service: { type: "string", multiple: true },
			env: { type: "boolean" },
			json: { type: "boolean" },
			dotenv: { type: "string" },
		},
	});
	const specs = (values.service ?? []).map(parseServiceSpec);
	if (specs.length === 0) die("claim needs at least one --service name:type[:ENV_VAR] (type: http | tcp)");

	const cwd = process.cwd();
	const project = values.project ? sanitizeLabel(values.project) : await detectProject(cwd);
	const session = values.name ? sanitizeLabel(values.name) : await detectSession(cwd);
	const key = `${project}/${session}`;

	const entry = await withLock(async () => {
		const registry = readRegistry();
		let entry = registry[key];
		if (entry && entry.worktree !== cwd && existsSync(entry.worktree)) {
			die(`${key} is already claimed by ${entry.worktree} — pass --name to disambiguate`);
		}
		if (!entry) {
			entry = { project, session, worktree: cwd, createdAt: new Date().toISOString(), services: {} };
			registry[key] = entry;
		}
		entry.worktree = cwd;
		const taken = new Set(
			Object.values(registry).flatMap((e) => Object.values(e.services).map((s) => s.port)),
		);
		for (const spec of specs) {
			const existing = entry.services[spec.name];
			if (existing && existing.type === spec.type) {
				existing.envVar = spec.envVar ?? existing.envVar;
				continue;
			}
			entry.services[spec.name] = {
				type: spec.type,
				port: await allocatePort(taken),
				domain: spec.type === "http" ? serviceDomain(spec.name, session, project) : undefined,
				envVar: spec.envVar,
			};
		}
		writeRegistry(registry);
		await syncCaddy(registry);
		return entry;
	});

	if (values.json) {
		console.log(JSON.stringify(entry, null, "\t"));
	} else if (values.env) {
		for (const [k, v] of envPairs(entry)) console.log(`export ${k}=${v}`);
	} else if (values.dotenv) {
		const body = envPairs(entry)
			.map(([k, v]) => `${k}=${v}`)
			.join("\n");
		await Bun.write(values.dotenv, `${body}\n`);
		console.log(`wrote ${values.dotenv}`);
		printEntry(entry);
	} else {
		printEntry(entry);
	}
}

async function removeEntries(registry: Registry, keys: string[]): Promise<void> {
	for (const key of keys) delete registry[key];
	writeRegistry(registry);
	await syncCaddy(registry);
}

async function release(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: { project: { type: "string" }, all: { type: "boolean" } },
		allowPositionals: true,
	});
	if (positionals.length > 1) die("release takes at most one session argument");

	await withLock(async () => {
		const registry = readRegistry();
		let keys: string[];

		if (values.all) {
			keys = Object.keys(registry);
		} else if (values.project) {
			const project = sanitizeLabel(values.project);
			keys = Object.keys(registry).filter((k) => registry[k].project === project);
			if (keys.length === 0) die(`no sessions found for project "${project}"`);
		} else if (positionals[0]) {
			const target = positionals[0];
			if (registry[target]) {
				keys = [target];
			} else {
				const matches = Object.keys(registry).filter((k) => registry[k].session === target);
				if (matches.length === 0) die(`no session named "${target}"`);
				if (matches.length > 1) die(`"${target}" is ambiguous (${matches.join(", ")}) — use project/session`);
				keys = matches;
			}
		} else {
			const cwd = process.cwd();
			const key = `${await detectProject(cwd)}/${await detectSession(cwd)}`;
			if (!registry[key]) die(`no claimed session for this worktree (${key}) — see \`portero ls\``);
			keys = [key];
		}

		await removeEntries(registry, keys);
		for (const key of keys) console.log(`released ${key}`);
	});
}

function shortenPath(path: string): string {
	return path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
}

async function ls(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
	const registry = readRegistry();
	if (values.json) {
		console.log(JSON.stringify(registry, null, "\t"));
		return;
	}
	if (Object.keys(registry).length === 0) {
		console.log("no sessions claimed");
		return;
	}
	const rows: string[][] = [["PROJECT", "SESSION", "SERVICE", "PORT", "STATUS", "DOMAIN", "WORKTREE"]];
	for (const key of Object.keys(registry).sort()) {
		const entry = registry[key];
		for (const name of Object.keys(entry.services).sort()) {
			const service = entry.services[name];
			rows.push([
				entry.project,
				entry.session,
				name,
				String(service.port),
				(await isPortListening(service.port)) ? "up" : "down",
				service.domain ?? "-",
				shortenPath(entry.worktree),
			]);
		}
	}
	const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
	for (const row of rows) {
		console.log(row.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd());
	}
}

async function gc(): Promise<void> {
	await withLock(async () => {
		const registry = readRegistry();
		const stale = Object.keys(registry).filter((key) => !existsSync(registry[key].worktree));
		if (stale.length === 0) {
			console.log("nothing to collect");
			return;
		}
		await removeEntries(registry, stale);
		for (const key of stale) console.log(`released ${key} (worktree gone)`);
	});
}

async function main(): Promise<void> {
	const [command, ...rest] = Bun.argv.slice(2);
	switch (command) {
		case "claim":
			return claim(rest);
		case "release":
			return release(rest);
		case "ls":
		case "list":
			return ls(rest);
		case "gc":
			return gc();
		case "lease":
			return leaseCommand(rest);
		case "setup":
			return setup();
		case "--version":
		case "-v":
			console.log(pkg.version);
			return;
		case undefined:
		case "help":
		case "--help":
		case "-h":
			console.log(HELP);
			return;
		default:
			die(`unknown command "${command}" — run \`portero help\`. State: ${registryPath()}`);
	}
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)));

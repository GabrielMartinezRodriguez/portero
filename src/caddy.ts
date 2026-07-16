import { caddyfilePath, type Registry } from "./registry";

export function renderCaddyfile(registry: Registry): string {
	const lines = [
		"# Managed by portero — regenerated on every claim/release. Do not edit.",
		"{",
		"\tlocal_certs",
		"}",
		"",
	];
	for (const key of Object.keys(registry).sort()) {
		const entry = registry[key];
		for (const name of Object.keys(entry.services).sort()) {
			const service = entry.services[name];
			if (service.type !== "http" || !service.domain) continue;
			lines.push(
				`${service.domain} {`,
				`\treverse_proxy 127.0.0.1:${service.port} {`,
				// Dev servers with host checking (e.g. vite) reject unknown Host
				// headers; hand them the upstream's own host:port instead.
				`\t\theader_up Host {http.reverse_proxy.upstream.hostport}`,
				"\t}",
				"}",
				"",
			);
		}
	}
	return lines.join("\n");
}

async function run(cmd: string[]): Promise<{ ok: boolean; stderr: string }> {
	const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
	const stderr = await new Response(proc.stderr).text();
	return { ok: (await proc.exited) === 0, stderr };
}

/**
 * For commands that daemonize (`caddy start`): the daemon inherits stdio, so
 * piping stderr and reading it to EOF would block until the daemon *exits*.
 * Never pipe here — discard everything and only await the launcher's exit.
 */
async function runQuiet(cmd: string[]): Promise<boolean> {
	const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	return (await proc.exited) === 0;
}

async function adminUp(): Promise<boolean> {
	try {
		const res = await fetch("http://localhost:2019/config/", { signal: AbortSignal.timeout(1500) });
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Rewrite the portero-owned Caddyfile from the registry and hot-reload Caddy.
 * Degrades to a warning (ports still work, domains don't) if Caddy is missing.
 */
export async function syncCaddy(registry: Registry): Promise<void> {
	const path = caddyfilePath();
	await Bun.write(path, renderCaddyfile(registry));
	if (!Bun.which("caddy")) {
		console.error("portero: warning: caddy is not installed — domains are not routed. Run `portero setup`.");
		return;
	}
	const reload = await run(["caddy", "reload", "--config", path, "--adapter", "caddyfile"]);
	if (reload.ok) return;
	if (await adminUp()) {
		// Caddy is running but rejected the config — starting another instance won't help.
		console.error(`portero: warning: caddy rejected the config:\n${reload.stderr.trim()}`);
		return;
	}
	await runQuiet(["caddy", "start", "--config", path, "--adapter", "caddyfile"]);
	if (!(await adminUp())) {
		console.error(`portero: warning: caddy did not come up — run \`caddy run --config ${path}\` to see why`);
	}
}

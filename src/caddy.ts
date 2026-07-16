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
			lines.push(`${service.domain} {`, `\treverse_proxy 127.0.0.1:${service.port}`, "}", "");
		}
	}
	return lines.join("\n");
}

async function run(cmd: string[]): Promise<{ ok: boolean; stderr: string }> {
	const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
	const stderr = await new Response(proc.stderr).text();
	return { ok: (await proc.exited) === 0, stderr };
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
	const start = await run(["caddy", "start", "--config", path, "--adapter", "caddyfile"]);
	if (!start.ok) {
		console.error(`portero: warning: could not reload or start caddy:\n${start.stderr.trim()}`);
	}
}

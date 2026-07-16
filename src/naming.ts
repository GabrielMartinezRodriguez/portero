import { basename, join } from "node:path";

/** DNS-safe label: lowercase alphanumerics and dashes, max 63 chars. */
export function sanitizeLabel(raw: string): string {
	const label = raw
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63);
	if (!label) throw new Error(`cannot derive a DNS-safe name from "${raw}"`);
	return label;
}

/** SCREAMING_SNAKE_CASE suffix for env var names. */
export function envify(name: string): string {
	return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function serviceDomain(service: string, session: string, project: string): string {
	return `${sanitizeLabel(service)}.${session}.${project}.test`;
}

async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
	const out = (await new Response(proc.stdout).text()).trim();
	return (await proc.exited) === 0 && out ? out : undefined;
}

/**
 * Project name, best-effort: package.json scope (`@ginger/monorepo` → `ginger`)
 * or name, then git remote repo name, then directory name.
 */
export async function detectProject(cwd: string): Promise<string> {
	const toplevel = (await git(cwd, "rev-parse", "--show-toplevel")) ?? cwd;
	try {
		const pkg = await Bun.file(join(toplevel, "package.json")).json();
		if (typeof pkg.name === "string" && pkg.name) {
			const scoped = pkg.name.match(/^@([^/]+)\//);
			return sanitizeLabel(scoped ? scoped[1] : pkg.name);
		}
	} catch {
		// no package.json or unparsable — fall through
	}
	const remote = await git(cwd, "remote", "get-url", "origin");
	if (remote) return sanitizeLabel(basename(remote).replace(/\.git$/, ""));
	return sanitizeLabel(basename(toplevel));
}

/**
 * Session name, best-effort: last segment of the git branch
 * (`feature/gps-fix` → `gps-fix`), then directory name.
 */
export async function detectSession(cwd: string): Promise<string> {
	const branch = await git(cwd, "branch", "--show-current");
	if (branch) {
		const segments = branch.split("/");
		return sanitizeLabel(segments[segments.length - 1] || branch);
	}
	return sanitizeLabel(basename(cwd));
}

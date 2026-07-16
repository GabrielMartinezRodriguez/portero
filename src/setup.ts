import { readFileSync } from "node:fs";
import { syncCaddy } from "./caddy";
import { readRegistry } from "./registry";

const DNSMASQ_RULE = "address=/test/127.0.0.1";
const RESOLVER_FILE = "/etc/resolver/test";

function step(message: string): void {
	console.log(`\n==> ${message}`);
}

function run(cmd: string[]): boolean {
	const proc = Bun.spawnSync(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	return proc.exitCode === 0;
}

function capture(cmd: string[]): string | undefined {
	const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
	const out = proc.stdout.toString().trim();
	return proc.exitCode === 0 && out ? out : undefined;
}

/**
 * One-time macOS setup: dnsmasq resolving *.test to 127.0.0.1, an /etc/resolver
 * entry so macOS actually uses it, and Caddy running as the local HTTPS proxy.
 * Idempotent — safe to re-run. Uses sudo for the system-level pieces.
 */
export async function setup(): Promise<void> {
	if (process.platform !== "darwin") {
		throw new Error("portero setup currently supports macOS only (dnsmasq + /etc/resolver)");
	}
	if (!Bun.which("brew")) {
		throw new Error("Homebrew is required: https://brew.sh");
	}
	const brewPrefix = capture(["brew", "--prefix"]);
	if (!brewPrefix) throw new Error("could not resolve brew --prefix");

	step("Installing dnsmasq (if missing)");
	if (!run(["sh", "-c", "brew list dnsmasq >/dev/null 2>&1 || brew install dnsmasq"])) {
		throw new Error("failed to install dnsmasq");
	}

	step(`Pointing *.test at 127.0.0.1 in ${brewPrefix}/etc/dnsmasq.conf`);
	const dnsmasqConf = `${brewPrefix}/etc/dnsmasq.conf`;
	let confContents = "";
	try {
		confContents = readFileSync(dnsmasqConf, "utf8");
	} catch {
		// missing conf — we'll create it
	}
	if (confContents.includes(DNSMASQ_RULE)) {
		console.log("already configured");
	} else if (!run(["sh", "-c", `printf '\\n# portero\\n${DNSMASQ_RULE}\\n' >> '${dnsmasqConf}'`])) {
		throw new Error(`failed to write ${dnsmasqConf}`);
	}

	step("Restarting dnsmasq (needs sudo — it binds port 53)");
	if (!run(["sudo", "brew", "services", "restart", "dnsmasq"])) {
		throw new Error("failed to restart dnsmasq");
	}

	step(`Routing the .test TLD to dnsmasq via ${RESOLVER_FILE} (needs sudo)`);
	if (!run(["sudo", "sh", "-c", `mkdir -p /etc/resolver && printf 'nameserver 127.0.0.1\\n' > ${RESOLVER_FILE}`])) {
		throw new Error(`failed to write ${RESOLVER_FILE}`);
	}
	run(["sudo", "killall", "-HUP", "mDNSResponder"]);

	step("Installing Caddy (if missing)");
	if (!run(["sh", "-c", "brew list caddy >/dev/null 2>&1 || brew install caddy"])) {
		throw new Error("failed to install caddy");
	}

	step("Starting Caddy with the portero Caddyfile");
	await syncCaddy(readRegistry());

	step("Trusting Caddy's local CA (may prompt for your password)");
	if (!run(["caddy", "trust"])) {
		console.error("warning: `caddy trust` failed — HTTPS will show certificate warnings until you run it manually");
	}

	step("Verifying that *.test resolves");
	if (run(["sh", "-c", "dscacheutil -q host -a name portero-setup-check.test | grep -q 127.0.0.1"])) {
		console.log("\nAll set. Claim your first session with e.g.:");
		console.log('  eval "$(portero claim --service api:http --service db:tcp --env)"');
	} else {
		console.error("\nwarning: portero-setup-check.test did not resolve to 127.0.0.1 yet.");
		console.error("DNS changes can take a moment — retry with: dscacheutil -q host -a name anything.test");
	}
}

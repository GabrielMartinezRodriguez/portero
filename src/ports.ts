const PORT_MIN = 20000;
const PORT_MAX = 49151;
const MAX_ATTEMPTS = 200;
const CONNECT_TIMEOUT_MS = 400;

/**
 * True if something accepts TCP connections on 127.0.0.1:port.
 *
 * This is a real connect(), not a bind() probe: on macOS, SO_REUSEADDR lets a
 * bind to 127.0.0.1 succeed even while another process listens on 0.0.0.0 of
 * the same port (vite --host, docker-proxy), so bind probes report wildcard
 * listeners as free.
 */
export async function isPortListening(port: number): Promise<boolean> {
	return await new Promise((resolve) => {
		let settled = false;
		const done = (listening: boolean) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(listening);
			}
		};
		const timer = setTimeout(() => done(false), CONNECT_TIMEOUT_MS);
		Bun.connect({
			hostname: "127.0.0.1",
			port,
			socket: {
				open(socket) {
					socket.end();
					done(true);
				},
				data() {},
				error() {
					done(false);
				},
				connectError() {
					done(false);
				},
			},
		}).catch(() => done(false));
	});
}

/** True if we can bind 127.0.0.1:port (second guard for exotic listeners). */
export function isPortBindable(port: number): boolean {
	try {
		const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
		listener.stop(true);
		return true;
	} catch {
		return false;
	}
}

/**
 * Pick a random port in the ephemeral-ish range that nothing is listening on,
 * avoiding ports already reserved in the registry (`taken`). Adds the result
 * to `taken`.
 */
export async function allocatePort(taken: Set<number>): Promise<number> {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const port = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
		if (taken.has(port)) continue;
		if (await isPortListening(port)) continue;
		if (!isPortBindable(port)) continue;
		taken.add(port);
		return port;
	}
	throw new Error(`could not find a free port in ${PORT_MIN}-${PORT_MAX} after ${MAX_ATTEMPTS} attempts`);
}

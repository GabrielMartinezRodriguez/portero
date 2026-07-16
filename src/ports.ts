const PORT_MIN = 20000;
const PORT_MAX = 49151;
const MAX_ATTEMPTS = 200;

/** True if nothing is listening on 127.0.0.1:port right now. */
export function isPortFree(port: number): boolean {
	try {
		const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
		listener.stop(true);
		return true;
	} catch {
		return false;
	}
}

/**
 * Pick a random free port in the ephemeral-ish range, avoiding ports already
 * reserved in the registry (`taken`). Adds the result to `taken`.
 */
export function allocatePort(taken: Set<number>): number {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const port = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
		if (taken.has(port)) continue;
		if (!isPortFree(port)) continue;
		taken.add(port);
		return port;
	}
	throw new Error(`could not find a free port in ${PORT_MIN}-${PORT_MAX} after ${MAX_ATTEMPTS} attempts`);
}

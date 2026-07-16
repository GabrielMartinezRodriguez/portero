export interface ServiceSpec {
	name: string;
	type: "http" | "tcp";
	envVar?: string;
}

/**
 * Parse a `--service` argument: `name:type[:ENV_VAR]`.
 * Examples: `api:http`, `db:tcp:MONGO_PORT`.
 */
export function parseServiceSpec(raw: string): ServiceSpec {
	const [name, type, envVar, ...rest] = raw.split(":");
	if (!name || !type || rest.length > 0) {
		throw new Error(`invalid service spec "${raw}" — expected name:type[:ENV_VAR]`);
	}
	if (type !== "http" && type !== "tcp") {
		throw new Error(`invalid service type "${type}" in "${raw}" — expected http or tcp`);
	}
	if (envVar !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
		throw new Error(`invalid env var name "${envVar}" in "${raw}"`);
	}
	return { name, type, envVar: envVar || undefined };
}

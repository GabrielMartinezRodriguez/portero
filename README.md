# portero

**Local port & domain allocator for parallel dev sessions.**

When you run several dev environments at once — one per git worktree, per branch, per AI agent — they all fight over `localhost:3000`. Portero is the doorman (*portero* also means "the one who hands out ports"): one command reserves free ports for your services, registers stable `https://*.test` domains for them, and keeps a global registry so every worktree and project on your machine coexists without a spreadsheet of port numbers.

```bash
$ eval "$(portero claim --project ginger --service api:http:PORT --service back:http --service db:tcp:MONGO_PORT --env)"
$ echo "$PORTERO_URL_API  ->  $PORT"
https://api.gps-fix.ginger.test  ->  42311
```

Portero does exactly three things:

1. **Reserves free ports** in a machine-global registry (`~/.local/state/portero/registry.json`), so two sessions can never collide — across projects, not just within one.
2. **Routes domains**: every `http` service gets `https://<service>.<session>.<project>.test` via a portero-managed [Caddy](https://caddyserver.com) reverse proxy, with locally-trusted TLS. `tcp` services (MongoDB, Postgres…) just get a port.
3. **Lists and releases** them: `portero ls` shows what every worktree is using and whether it's live; `portero release --all` frees everything at once.

It deliberately does **not** create worktrees, start your services, or manage processes. Your worktree tool (plain `git worktree`, an agent IDE, a Makefile) calls portero from its setup script and does the rest with the env vars it gets back.

## Install

Requires [Bun](https://bun.sh) and macOS (for `setup`; the allocator itself is cross-platform).

```bash
git clone https://github.com/GabrielMartinezRodriguez/portero
cd portero && bun install && bun link   # provides the `portero` command
```

Then run the one-time system setup (installs/configures dnsmasq and Caddy via Homebrew; asks for sudo where needed):

```bash
portero setup
```

This makes every `*.test` domain resolve to `127.0.0.1` (dnsmasq + `/etc/resolver/test`) and starts Caddy with a locally-trusted CA. `.test` is the IANA-reserved TLD for exactly this; portero never touches `/etc/hosts`.

## Usage

### `portero claim`

Reserve resources for the current worktree. **Idempotent**: re-running it returns the same allocation, so it's safe in setup scripts that re-run.

```bash
portero claim \
  --service api:http:PORT \        # name:type[:ENV_VAR]
  --service back:http \
  --service db:tcp:MONGO_PORT \
  --env                            # print eval-able exports
```

- **Project** is auto-detected (package.json scope/name → git remote → directory), or pass `--project`.
- **Session** is auto-detected from the git branch's last segment (`feature/gps-fix` → `gps-fix`), or pass `--name`.
- Output modes: `--env` (eval-able exports), `--json`, `--dotenv .env.session` (writes a file), or a human summary by default.

Exported variables:

| Variable | Example |
|---|---|
| `PORTERO_PROJECT` / `PORTERO_SESSION` | `ginger` / `gps-fix` |
| `PORTERO_PORT_<SERVICE>` | `PORTERO_PORT_API=42311` |
| `PORTERO_URL_<SERVICE>` (http only) | `https://api.gps-fix.ginger.test` |
| Custom alias from `name:type:ENV_VAR` | `PORT=42311`, `MONGO_PORT=42313` |

### `portero ls`

```
PROJECT  SESSION   SERVICE  PORT   STATUS  DOMAIN                        WORKTREE
ginger   gps-fix   api      42311  up      api.gps-fix.ginger.test      ~/worktrees/ginger/gps-fix
ginger   gps-fix   db       42313  up      -                            ~/worktrees/ginger/gps-fix
heureka  main      web      38402  down    web.main.heureka.test        ~/code/heureka
```

`STATUS` reflects whether something is actually listening on the port right now. `--json` for scripts.

### `portero release`

```bash
portero release                    # session claimed by the current worktree
portero release ginger/gps-fix     # by full name
portero release gps-fix            # by session (if unambiguous)
portero release --project ginger   # everything from one project
portero release --all              # everything, full stop
```

### `portero gc`

Releases every session whose worktree directory no longer exists — run it after deleting worktrees without ceremony.

## Wiring it into a worktree setup script

Whatever creates your worktrees (git alias, agent IDE post-create hook, Makefile), add:

```bash
#!/usr/bin/env bash
set -euo pipefail
eval "$(portero claim --project myapp --service api:http:PORT --service db:tcp:DB_PORT --env)"

docker compose -p "myapp-$PORTERO_SESSION" up -d      # isolated containers per session
./scripts/seed.sh                                     # your stack, your rules
echo "backend on $PORTERO_URL_API (port $PORT), db on 127.0.0.1:$DB_PORT"
```

And on teardown (or just periodically): `portero release` / `portero gc`.

## How it works

- **Registry**: a single JSON file at `~/.local/state/portero/registry.json` (override with `PORTERO_STATE_DIR`). Mutations take a lock, so concurrent claims from parallel setup scripts are safe. Ports are picked at random from 20000–49151 and verified free by binding them.
- **Caddy**: portero owns a Caddyfile at `~/.local/state/portero/Caddyfile`, regenerates it from the registry on every claim/release, and hot-reloads Caddy (starting it if needed). `local_certs` gives you HTTPS with Caddy's local CA — `portero setup` runs `caddy trust` so your system trusts it.
- **DNS**: dnsmasq answers `*.test` → `127.0.0.1`; `/etc/resolver/test` tells macOS to ask dnsmasq for that TLD only. No per-session DNS changes, ever.
- **No Caddy installed?** Claims still work — you just get ports without domains, and a warning.

### Caveats

- Devices that don't use your Mac's resolver (a physical phone, the Android emulator) can't resolve `*.test`. For mobile targets, use the raw `host:port` from the claim (that's what the env vars are for).
- Portero owns its Caddy instance's config. If you already run Caddy with your own config, don't point both at the same instance.

## License

MIT

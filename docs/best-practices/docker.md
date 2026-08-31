# Docker Build Conventions

## Shared Dockerfile

All server-side services (`api`, `worker`) are built from the root `Dockerfile` using BuildKit multi-stage targets.

| Target | Used by | Purpose |
|---|---|---|
| `build-shared` | dev compose, CI | installs deps + compiles 7 shared packages once |
| `build-api` | internal | extends `build-shared`, compiles api |
| `build-worker` | internal | extends `build-shared`, compiles worker |
| `api` | production | self-contained api runtime image |
| `worker` | production | self-contained worker runtime image |

Shared packages are compiled **once** in `build-shared`. Both `api` and `worker` inherit from that stage — halving peak memory and build time on the low-RAM Hetzner server (`cx23`, 4 GB, no swap).

## Dev compose

`docker-compose.dev.yaml` uses `target: build-shared` for both `api` and `worker`. The app package itself is not compiled — `tsx/esm` runs the TypeScript source directly at runtime.

## Do not wipe build cache between deploys

`docker builder prune` must not run as part of `push.sh` or `reset.sh`. BuildKit manages its own cache size automatically. Pruning after every deploy guarantees a 30-minute cold build next time.

If a specific image needs a cache-busting rebuild (e.g. after a suspected corrupt layer per [bug 020](../bug-reports/2026/06/23/020-worker-crash-loop-wrong-workdir.md)), use:
```bash
docker compose build --no-cache api worker
```

## Other images

| Image | Dockerfile | Notes |
|---|---|---|
| `herobids-agent:latest` | `docker/Dockerfile.agent` | Built explicitly in `push.sh` before compose up |
| migrate | `docker/Dockerfile.migrate` | One-shot; no TypeScript compilation |
| web | `apps/web/Dockerfile` | Vite/React; separate build chain |


## Agent Image (`Dockerfile.agent`)

The agent image (`docker/Dockerfile.agent`) is a separate Dockerfile from the shared `Dockerfile`. It builds a lean container for the agent reasoning loop — no bot actor, BullMQ worker, or trading engine code.

### Key packages

| Package | Why |
|---|---|
| `iproute2`, `iptables`, `ip6tables` | Network namespace creation for `sandbox-exec.sh` |
| `gcompat` | glibc compatibility shim — required because `agent-browser` ships pre-built Rust binaries linked against glibc, but the base image is Alpine (musl) |
| `sudo` | Passwordless sudo for the `agent` user — enables the `full` permission level to run commands as root |
| `python3`, `py3-pip`, `git` | Development tooling for `execute_code` and `execute_shell` |
| `agent-browser@0.14.0` | Browser automation CLI (Rust binary), installed globally via `npm install -g`. Connects to the shared Browserless pool over CDP — no local Chrome |

### Non-root `agent` user

The image creates a non-root `agent` user with passwordless sudo:

```dockerfile
RUN adduser -D -h /home/agent agent && \
    echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent && \
    chmod 0440 /etc/sudoers.d/agent
```

The container still starts as root because `sandbox-exec.sh` requires `CAP_NET_ADMIN` for network namespace creation. The `execute_shell` tool drops to the `agent` user for `standard` mode and stays root for `full` mode.

### `agent-entrypoint.sh`

The entrypoint script (`scripts/agent-entrypoint.sh`) runs before the main process and writes runtime config files based on environment variables:

- If `AGENT_BROWSER_CDP_URL` is set, writes a config file at `/home/agent/.agent-browser/config.json` with the CDP WebSocket URL. This tells the `agent-browser` CLI how to connect to the Browserless pool without needing provider flags.

The entrypoint then `exec`s the CMD (`node dist/agent.js`).

### Build conventions

- The agent image is listed in the "Other images" table above — it is built explicitly in `push.sh` before `docker compose up`, not as part of the shared multi-stage pipeline.
- Pin third-party binary versions (e.g. `agent-browser@0.14.0`) for reproducible builds.
- Do not run `agent-browser install` in the Dockerfile — that downloads Chrome (~684 MB) which the agent does not need. The CLI connects to a remote Browserless pool.

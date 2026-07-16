# Bug Report: `push.sh`/`deploy.sh` Deploy Hangs — Parallel Docker Bake Starves 2-vCPU/4GB Staging Box

- **Status:** OPEN (workaround applied manually this run; not yet fixed in scripts)
- **Severity:** High — every deploy to `cx23`-class boxes (2 vCPU, 4 GB RAM, no swap) risks appearing to hang indefinitely and can OOM-kill live containers.
- **Date:** 2026-07-16
- **Discovered By:** User ran `infra/hetzner/deploy.sh` against staging; build appeared stuck for 15+ minutes at the `api`/`worker` `tsc --build` step with no further output.
- **Environment:** staging (`128.140.55.192`), Hetzner `cx23` (2 vCPU, 3.7 GiB RAM, 0 swap), 7 live agent containers + api/worker/web/caddy/postgres/redis already running at deploy time.

## Observed Behavior

`push.sh` runs `docker compose -f docker-compose.yaml -f docker-compose.staging.yaml up -d --build --remove-orphans`. Compose v2 uses `docker buildx bake` by default (`COMPOSE_BAKE`), which builds independent targets (`web`, `migrate`, `worker`, `api`) **concurrently**. On this box that means up to 4 concurrent Node/`tsc --build` processes competing with the already-running worker process and 7 live agent containers for 2 vCPUs and ~4 GB RAM with **no swap configured**.

Symptoms:
- Steps that should take seconds (e.g. `api`/`worker` final `tsc --build`, which only compiles the small app package after shared packages are already built) instead ran for 15+ minutes with zero output, looking hung.
- `top`/`free` on the server showed `load average: 15.95, 83.52, 71.58` on a 2-vCPU box, ~108 MiB free RAM, 0 swap.
- `dmesg` showed the OOM killer fired and killed `redis-server` mid-deploy (`Out of memory: Killed process ... (redis-server)`), which Docker's restart policy silently recovered, but any critical process (postgres, api) could have been killed instead.
- The build was **not** actually deadlocked — `docker buildx bake` was still alive and consuming CPU — it was just so CPU/memory-starved that visible progress took an extreme amount of time.

## Root Cause

1. `docker compose ... up -d --build` lets buildx bake parallelize independent image targets (`web`, `migrate`, `worker`, `api`) with no concurrency limit.
2. The target server is a 2-vCPU, 4 GB, **swapless** box that is *also* running the full existing stack (postgres, redis, api, worker, web, caddy) plus multiple live trading agent containers throughout the deploy — build and runtime never get isolated resource budgets.
3. `docs/best-practices/docker.md` already documents this box as low-RAM/no-swap and addresses *peak memory within a single image* (shared `build-shared` stage for api+worker), but does not address contention **across concurrently-built images**, which is the actual failure mode here.

## Workaround Applied This Run (staging, manual, temporary)

1. Added a temporary 2 GB swapfile (`/swapfile-tmp`) as an OOM safety net.
2. Killed the stuck `docker compose ... up -d --build` process (PID via `docker compose`/`buildx bake`).
3. Rebuilt each image **sequentially** instead of via parallel bake:
   ```bash
   export COMPOSE_BAKE=false
   for svc in migrate web worker api; do
     docker compose -f docker-compose.yaml -f docker-compose.staging.yaml build "$svc"
   done
   ```
   All four images built in well under a minute each once serialized (no CPU contention).
4. Ran `docker compose ... up -d --remove-orphans` (images already built, so no rebuild needed) and `restart caddy`, matching the rest of `push.sh`'s flow.
5. Removed the temporary swapfile after the deploy completed healthy.

This got the deploy unblocked but is **not** a permanent fix — the next deploy will hit the same contention.

## What Still Needs Fixing

1. **Serialize (or bound concurrency of) the image build in `push.sh`.** Replace `up -d --build` with an explicit sequential (or `--parallel 1`) build step before `up -d`, or set `COMPOSE_BAKE=false` for these low-resource hosts so compose falls back to non-bake sequential build ordering. Sequential build was ~10x faster wall-clock here than the contended parallel build, in addition to being safer.
2. **Provision persistent swap on `cx23` boxes**, or document/accept the tradeoff explicitly — `docs/best-practices/docker.md` currently states "no swap" as a given; given repeated OOM incidents on this box (see also `docs/bug-reports/2026/07/15/001-redis-agent-outbound-streams-unbounded-memory-exhaustion.md`), a small persistent swapfile provisioned in `infra/hetzner/cloud-init.yaml` would reduce blast radius of future memory spikes (build-time or runtime) without masking the underlying constraint.
3. **`push.sh` should not build images while the full stack (including live agent containers) is running unthrottled** — consider `nice`/`ionice` on the build step, or briefly pausing/throttling non-critical agent containers during the build window, or moving to a build server / registry-based deploy (build off-box, push image, pull on deploy) so the constrained box never runs `tsc` at all.
4. **Add a deploy-time resource check** (free memory / load average) that warns or aborts before starting a build if the box is already under heavy load, rather than silently degrading.

## Files That Likely Need Changes

- `infra/hetzner/scripts/push.sh` — replace `docker compose ... up -d --build` with a sequential/bounded-concurrency build step.
- `docs/best-practices/docker.md` — document the cross-image build concurrency constraint, not just per-image peak memory.
- `infra/hetzner/cloud-init.yaml` / `variables.tf` — consider provisioning persistent swap as a safety net, or explicitly deciding against it with rationale.

## Verification (this run)

- Staging deploy completed: all containers (`api`, `worker`, `web`, `migrate`, `caddy`, `postgres`, `redis`, docker-proxy, 7 agent containers) healthy/running.
- `curl http://localhost:3000/health` returned healthy.
- Temporary swapfile removed; server memory/swap state restored to pre-deploy configuration (0 swap).

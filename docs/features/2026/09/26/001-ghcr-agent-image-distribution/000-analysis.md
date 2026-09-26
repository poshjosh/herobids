# Analysis — Agent image distribution to Nomad client nodes (GHCR)

**Status:** analysis + plan; implementation follows
**Date:** 2026-09-26

## Why this is needed (the full incident chain)

On 2026-09-25 the `herobids-staging` control plane was torn down and
re-provisioned. That surfaced a **six-layer stack of missing Nomad bootstrap
steps**, each masking the next. In order they were hit and fixed:

1. **Private NIC `enp7s0` down** — Hetzner attaches the private network at the
   hypervisor but the guest OS doesn't bring `enp7s0` up on first boot; no `10.x`
   route; netplan only configured `eth0`. → reboot (+ manual IP since cloud-init's
   `sed` is first-boot only).
2. **`__PRIVATE_IP__` placeholder** — cloud-init's runcmd `sed` never substituted
   because layer 1 left no private IP to grep. → `sed -i s/__PRIVATE_IP__/10.0.0.2/` + restart.
3. **Stale ACL token** — Nomad ACL state lives in the server's data dir, lost on
   recreation. `.env.backend` still held the old token so `setup-nomad.sh` skipped
   bootstrap. → clear token, re-run `setup-nomad.sh`.
4. **UFW blocked worker→Nomad** — worker runs on the Docker bridge (`172.18.0.0/16`)
   but the Nomad UFW rules only allow the private subnet (`10.0.0.0/24`). → `ufw allow
   from 172.18.0.0/16` + pin bridge subnet in `docker-compose.yaml`.
5. **Missing `herobids-agents` namespace** — nothing created it (worker hardcodes it
   from `config/default.yaml`). → `nomad namespace apply` (now folded into `setup-nomad.sh`).
6. **Agent image never reaches the client node** — the gap this feature closes.

## The current gap (layer 6)

The worker's `NomadRuntimeAdapter` submits a Nomad `docker` task with
`image: "herobids-agent:latest"` and no registry qualification or pull policy.
The image is only ever built **locally on the control plane** by `push.sh`:

```sh
docker build --pull -f docker/Dockerfile.agent -t herobids-agent:latest .
```

There is no `docker push`, no `docker save | load`, no local registry, and no
Nomad `artifact` stanza. So the client node's Docker driver tries Docker Hub,
finds no `herobids-agent`, task fails → `Stale agent start detected` →
`agent.runtime.failed` → "Critical execution failure".

## Decision: Option A — push to GHCR

Mirror traderton's proven pattern (`.github/workflows/build-push.yml` →
`ghcr.io/<owner>/<repo>:sha-<commit>` + `:latest`, gated deploy polling). For
herobids we use a **dedicated** package `ghcr.io/poshjosh/herobids-agent` since
the agent image is built from a separate `docker/Dockerfile.agent` (not the app
image).

### Sub-decisions applied

- **Dedicated package name:** `ghcr.io/poshjosh/herobids-agent`.
- **Tags:** `:latest` (convenience) + `:sha-<full 40-hex sha>` (immutable, for the
  deploy gate). `:latest` is the runtime default for now; pinning to sha at deploy
  time is a documented follow-up.
- **CI auth:** `GITHUB_TOKEN` with `packages: write` (private repo → private package),
  no extra secret needed — same as traderton.
- **Pull-side auth:** the agent node must `docker login ghcr.io` with a `read:packages`
  token; wired via `GHCR_USERNAME`/`GHCR_TOKEN` env (Terraform template → cloud-init).
- **Polling:** reuse traderton's `waitBeforePollingSeconds` convention — wait a
  known-minimum delay before the first GitHub API poll to avoid burning
  (rate-limited) requests.

## Critical pitfall discovered: `nomad.agentImage` is DEAD config

`NomadRuntimeAdapterConfig.agentImage` (set from `NOMAD_AGENT_IMAGE ??
appConfig.nomad.agentImage`) is **never used** — `buildNomadJobSpec` reads
`config.image` from the launch config instead (noted as "dead config" in
`docs/features/2026/07/08/004-orchestration/006-followup-plan.md` §5).

The actual image comes from `agent-runtime-launcher.ts`:

```ts
image: config.image ?? 'herobids-agent:latest',
```

`agent-session-manager.ts` never sets `config.image`, so the hardcoded
`'herobids-agent:latest'` always wins. To make Option A work we must thread the
configured image through the launcher (not just fix `default.yaml`), otherwise
the registry-qualified name is silently ignored.

## Files touched

- `.github/workflows/build-push-agent.yml` — NEW, CI build+push of the agent image
- `config/default.yaml` + `packages/domain/src/config/schema.ts` — `nomad.agentImage` default
- `apps/worker/src/agents/agent-runtime-launcher.ts` — accept `agentImage` config, use as fallback
- `apps/worker/src/index.ts` — pass `NOMAD_AGENT_IMAGE ?? nomad.agentImage` to the launcher
- `infra/hetzner/cloud-init-nomad-client.yaml` — `docker login ghcr.io` on agent node
- `infra/hetzner/main.tf` + `variables.tf` — thread `ghcr_username`/`ghcr_token` to the agent-node template
- `infra/hetzner/.env.environment.example` + `.env.staging`/`.env.production` — `GHCR_*` env twins
- `infra/hetzner/scripts/setup-nomad.sh` — (already done) create the agent namespace

## Pitfalls / notes for the implementer

- `.env` twins: any new `GHCR_*` env var MUST be added to the committed `.example`
  twin in the SAME change (repo rule; see AGENTS.md).
- Agent nodes are cattle; the `docker login` must live in `cloud-init-nomad-client.yaml`
  (first-boot runcmd), not ad-hoc, or scale-outs re-break.
- CI push and deploy can race. Nomad's docker driver retries pulls and `:latest`
  eventually converges; sha-pinning + a wait-for-build gate is the durable fix
  (documented follow-up, mirrors traderton's `wait-for-build.sh`).
- The `ghcr_token` variable is `sensitive`; it must never be committed to tfvars
  (tfvars are gitignored) and should be a `read:packages`-only PAT or deploy-use token.
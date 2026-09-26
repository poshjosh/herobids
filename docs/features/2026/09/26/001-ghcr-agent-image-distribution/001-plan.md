# Plan — Publish `herobids-agent` to GHCR and pull it onto Nomad client nodes

**Status:** planned → implementing
**Date:** 2026-09-26
**Parent:** `000-analysis.md`
**Depends on:** bug report `docs/bug-reports/2026/09/26/002-agent-image-not-distributed-to-nomad-client-node.md`

## Goal

Make `herobids-agent:latest` retrievable by Nomad client nodes so agent jobs
stop failing with `Stale agent start detected` / "Critical execution failure".

## Ordered work

### Stage 1 — CI build & push the agent image to GHCR

New `.github/workflows/build-push-agent.yml`:
- trigger on `push: branches: [main]` (+ `workflow_dispatch`).
- `permissions: contents: read, packages: write`.
- checkout → buildx → `docker/login-action` (ghcr.io, `github.actor` + `GITHUB_TOKEN`).
- build-push with `context: .`, `file: docker/Dockerfile.agent`, tags:
  `ghcr.io/poshjosh/herobids-agent:latest` and `ghcr.io/poshjosh/herobids-agent:sha-<github.sha>`.

### Stage 2 — Thread the configured agent image through the worker

The current launcher hardcodes `'herobids-agent:latest'` (see analysis — the
`nomad.agentImage` config is dead). Fix:
- `agent-runtime-launcher.ts`: add `agentImage` to `AgentRuntimeLauncherConfig`
  and `LauncherLaunchConfig`; use `config.image ?? this.agentImage ?? 'herobids-agent:latest'`.
- `index.ts`: pass `agentImage: process.env['NOMAD_AGENT_IMAGE'] ?? appConfig.nomad.agentImage`
  to the launcher (and/or let the launcher read it).
- `config/default.yaml` + `packages/domain/src/config/schema.ts`: default
  `nomad.agentImage` → `ghcr.io/poshjosh/herobids-agent:latest`.

### Stage 3 — Agent node pulls GHCR (auth on the client)

`infra/hetzner/cloud-init-nomad-client.yaml` runcmd: after Docker install, run
`docker login ghcr.io -u ${ghcr_username} --password-stdin` using a
`read:packages` token, so the Nomad docker driver can pull the private image.
Thread `${ghcr_username}` / `${ghcr_token}` through `main.tf`
(`hcloud_server.agent` user_data templatefile) and add matching `variables.tf`
(sensitive token).

### Stage 4 — Env twins + docs

- `infra/hetzner/.env.environment.example` (+ `.env.staging` / `.env.production`
  note) — add `GHCR_USERNAME=`, `GHCR_TOKEN=` with inline comments.
- `infra/hetzner/docs/setup.md` Phase 6/7 — add the GHCR publish/pull step and
  the "image reaches client node" verification.
- `docs/features/2026/07/08/004-orchestration/006-followup-plan.md` — note the
  agentImage dead-config fix is now landed.

## Verification

- CI workflow builds and pushes tags (visible in GHCR UI / `docker manifest inspect`).
- `docker pull ghcr.io/poshjosh/herobids-agent:latest` succeeds on an agent node after login.
- Starting an agent registers a Nomad job → allocation runs → heartbeat received (no `Stale agent start detected`).
- `tsc`/`lint` pass; `docker compose config --quiet` unaffected.

## Deferred (documented, not in this change)

- **sha-pinning + wait-for-build gate** at deploy time (mirror traderton
  `wait-for-build.sh`) — currently `:latest` with Nomad's pull retry suffices.
- Rotating the `read:packages` token / using a deploy-only token.

## Risk

- Low. Additive CI + config; agent-node login is first-boot only; no local dev
  path changes (docker mode still uses `herobids-agent:latest` built locally).
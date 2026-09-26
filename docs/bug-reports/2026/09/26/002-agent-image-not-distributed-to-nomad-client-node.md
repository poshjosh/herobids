# Bug Report 002 — Agent image never reaches Nomad client node (no distribution mechanism)

- **Status:** FIXED (option A=GHCR implemented; uncommitted, pending review/deploy)
- **Severity:** High (blocks all agent runtime launches on Nomad)
- **Date:** 2026-09-26
- **Environment:** staging (`herobids-staging`); same gap applies to production and any Nomad deployment
- **Parent chain:** follows bug report 001 (worker→Nomad UFW). Final layer after NIC down → `__PRIVATE_IP__` → stale ACL → UFW bridge → missing `herobids-agents` namespace → **image distribution**.

## Summary

After the namespace and firewall fixes, the agent job now **registers and
places** successfully, but ~29s later the health monitor logs
`Stale agent start detected` and the runtime is stopped/purged — surfaced as
another `agent.runtime.failed` / "Critical execution failure".

The agent container never starts because the Nomad client node
(`herobids-staging-agent-1`, `10.0.0.3`) cannot obtain the `herobids-agent:latest`
image. `docker image ls` on that node is empty.

## Root Cause

The worker (`NomadRuntimeAdapter` → `buildNomadJobSpec`) submits a Nomad `docker`
task with `image: "herobids-agent:latest"` and **no pull policy**. There is no
registry prefix and no registry configured anywhere in `infra/` or `config/`.

The image is only ever built **locally on the control plane** by
`infra/hetzner/scripts/push.sh`:

```sh
docker build --pull -f docker/Dockerfile.agent -t herobids-agent:latest .
```

There is **no** `docker push`, no `docker save | docker load` to agent nodes, no
Nomad `artifact` stanza, and no local registry service. As a result the Nomad
client node's Docker driver attempts to pull `herobids-agent:latest` from Docker
Hub (which does not exist), the task fails, and the agent never heartbeats.

This is a genuine gap in the Nomad orchestration delivered under
`docs/features/2026/07/08/004-orchestration/002-implementation-plan.md`: the
plan plumbs `agentImage` through config and the job spec, but never specifies
how the image reaches the client node. It was likely never exercised end-to-end
with a genuinely empty client node.

## Options (decision awaited — do not pick unilaterally)

- **A. Push to a registry** (Docker Hub / GHCR / private). Set `agentImage` to a
  registry-qualified name; add a publish step to `push.sh`; provide registry
  credentials to agent nodes. Cleanest long-term; adds a credential + publish step.
- **B. `docker save` + `docker load` onto each agent node** in the deploy/
  scale-out path, so the image is present before jobs place. No registry; adds a
  distribute step that must re-run on every image change and scale-out.
- **C. Local registry container on the control plane** (`registry:2`), point
  agent nodes' Docker daemons at it via insecure-registry config. Middle ground;
  no external dependency but tighter coupling to the control-plane host.

## Files

- `infra/hetzner/scripts/push.sh` — builds `herobids-agent:latest` locally; no publish/distribute step
- `apps/worker/src/agents/nomad-runtime-adapter.ts` — `buildNomadJobSpec` sets `Config.image = config.image` with no pull policy
- `config/default.yaml` + `packages/domain/src/config/schema.ts` — `nomad.agentImage: herobids-agent:latest`
- `infra/hetzner/cloud-init-nomad-client.yaml` — installs Docker + Nomad client; no registry/artifact config

## Verification

- Agent job registers and places (nomad job registered at 21:14:43).
- `Stale agent start detected` at 21:15:12 → session `start timed out` → job purged.
- `ssh root@10.0.0.3 'docker image ls'` (via control plane deploy_key) → empty.

## Related

- `docs/bug-reports/2026/06/06/2026-06-06-20-agent-image-not-built.md` (same class, Docker-mode)
- `docs/features/2026/07/08/004-orchestration/002-implementation-plan.md`
- Repo memory `herobids-staging-nomad-investigation.md`
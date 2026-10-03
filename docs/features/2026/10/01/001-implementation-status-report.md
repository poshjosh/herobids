# Implementation Status Report — Sept 2026 feature folders

**Date:** 2026-10-01
**Author:** engineering review
**Scope:** Verify what has actually landed in code for the documents in four
feature folders. This report is the only artifact produced; no source, config,
or infra was modified.

## Folders reviewed

1. `docs/features/2026/09/23/` — external-skill remote-boundary migration plan
2. `docs/features/2026/09/24/` — staging-first External Backend program (roadmap, program tracker, infra plans)
3. `docs/features/2026/09/26/001-ghcr-agent-image-distribution/`
4. `docs/features/2026/09/27/001-nomad-labels-map-should-be-list/`

## Summary table

| Folder | Feature | Status | Evidence |
|---|---|---|---|
| 09/26 | GHCR agent image distribution | **Implemented** | commit `7228c279` + follow-ups |
| 09/27 | Nomad `labels` map → list of maps (+ `env` to task level) | **Implemented, tested** | commits `b10bd089`, `647691f2` |
| 09/23 | External-skill remote-boundary migration | **Not implemented (by design — superseded draft)** | superseded by ADR 015 |
| 09/24 | Staging-first External Backend program | **Phase 1 Steps 1–2 done (live on staging); Step 3–4 effectively in place; Phase 2–3 not started** | live TF state + endpoints + `.env.staging` |

---

## 1. 09/26 — GHCR agent image distribution — IMPLEMENTED

The plan (`001-plan.md`) and analysis (`000-analysis.md`) describe closing
"layer 6": making `herobids-agent` retrievable by Nomad client nodes via GHCR.
All four plan stages have landed in this repo (commit `7228c279`, "fix(infra):
publish agent image to GHCR and wire Nomad client pulls").

**Stage 1 — CI build & push.** `.github/workflows/build-push-agent.yml` exists:
triggers on `push: [main]` + `workflow_dispatch`, `permissions: contents: read,
packages: write`, logs into `ghcr.io` with `github.actor` / `GITHUB_TOKEN`,
builds `docker/Dockerfile.agent`, and pushes
`ghcr.io/poshjosh/herobids-agent:latest` **and** `:sha-${{ github.sha }}` — exactly
the planned tags.

**Stage 2 — thread the configured image through the worker.** The "dead config"
pitfall called out in the analysis is fixed:
- `apps/worker/src/agents/agent-runtime-launcher.ts` adds `agentImage` to
  `AgentRuntimeLauncherConfig` and resolves it as
  `config.image ?? this.agentImage ?? 'herobids-agent:latest'`.
- `apps/worker/src/index.ts` passes
  `agentImage: process.env['NOMAD_AGENT_IMAGE'] ?? appConfig.nomad.agentImage`
  into the Nomad launcher.
- `config/default.yaml` sets `nomad.agentImage: ghcr.io/poshjosh/herobids-agent:latest`.
- `packages/domain/src/config/schema.ts` defaults `agentImage` to the same
  registry-qualified value.

**Stage 3 — agent node pulls GHCR.** `infra/hetzner/cloud-init-nomad-client.yaml`
runs `docker login ghcr.io -u "${ghcr_username}" --password-stdin` on first boot
(guarded on both vars being set). `infra/hetzner/main.tf` threads
`ghcr_username` / `ghcr_token` into the agent-node `user_data`;
`infra/hetzner/variables.tf` declares both (`ghcr_token` marked `sensitive`).

**Stage 4 — env twins + docs.** `.example` twins carry the new keys:
`infra/hetzner/.env.environment.example`, `.env.staging`, `.env.production`
(`GHCR_USERNAME` / `GHCR_TOKEN`), and `environment.tfvars.example` /
`terraform.tfvars.example` (commented `ghcr_username` / `ghcr_token`).
`infra/hetzner/docs/setup.md` documents the pull/verify step.

**Deferred items — correctly still deferred (not implemented):** sha-pinning
plus a wait-for-build deploy gate, and read:packages token rotation. Both are
documented as follow-ups in the plan; neither is present, which matches intent.

**Security finding (new — not in the original docs).** `infra/hetzner/staging.tfvars`
contains a **real** `ghcr_token` value (`ghp_…`) and `ghcr_username = "poshjosh"`.
The file is gitignored (`git check-ignore` confirms it is not committed), so this
is not a repo leak, but a live GitHub token sits in plaintext on disk. Per the
repo rule flagged in the analysis, tfvars must never hold committed secrets — this
one is uncommitted but should still be rotated and treated as exposed, and ideally
sourced from a secret store rather than a plaintext tfvars file. No change was
made (out of this report's allowed scope).

---

## 2. 09/27 — Nomad `labels` map → list of maps — IMPLEMENTED & TESTED

The analysis/plan describe two latent bugs in
`apps/worker/src/agents/nomad-runtime-adapter.ts` that made every agent
allocation fail client-side validation. Both fixes are present (commits
`b10bd089` then `647691f2`):

1. **`labels` is now a list of maps.** `NomadJobSpec.Config.labels` is typed
   `Array<Record<string, string>>` and `buildNomadJobSpec` serializes it as a
   single-element list: `[{ ...config.labels, 'herobids.managed-by': 'nomad' }]`
   — the `[]map[string]string` form the Nomad v1.9 docker driver expects.
2. **`env` moved to task level.** `Env` is now a sibling of `Config` on the task
   (`Env?: Record<string,string>`), no longer nested inside the docker driver
   `Config` block.

`NomadJobSpec` and `buildNomadJobSpec` are exported for testability. The new
`apps/worker/src/agents/nomad-runtime-adapter.test.ts` adds the 3 planned tests
(labels is a list of maps; `env` is task-level and absent from `Config`; image +
namespace flow through). **Verified: 3/3 pass** (`vitest run` on that file).

**Deploy note (from the plan) is operational, not code:** the running worker must
be rebuilt/redeployed for the fix to take effect. That is a deployment action and
is outside this repo's committed state.

---

## 3. 09/23 — External-skill remote-boundary migration — NOT IMPLEMENTED (by design)

This document is explicitly a **superseded, non-governing discovery draft**
("Do not implement from this document"), superseded by
[ADR 015](../../../../tech/architecture/adrs/2026/09/015-external-backend-skill-registration.md)
(status: **Accepted**). So "not implemented" is the correct and intended state.

Confirmed against code:
- The concrete Traderton module the plan wanted to generalize/remove still
  exists in full: `packages/domain/src/traderton/` (`client.ts`, `contract.ts`,
  `sign.ts`, `index.ts`, plus tests).
- No generic `remote-boundary` code module exists (only the draft doc itself).
- No generic `external-backend` **code** module exists either — the term appears
  only in ADRs (008, 009, 015) and `docs/features/pending/000-capability-foundations/`.

The draft's rejected vocabulary (`RemoteBoundary`) was replaced by ADR 015's
`ExternalBackendClient` / `ExternalBackendDefinition`, and the whole genericization
effort is sequenced as **Phase 3** of the 09/24 roadmap — gated behind Phase 1
staging operational proof, which has not completed. No aspect of the target data
model, generic contracts, or client migration has been built.

---

## 4. 09/24 — Staging-first External Backend program — PHASE 1 STEPS 1–2 DONE (live on staging); PHASE 2–3 NOT STARTED

> **Correction (2026-10-01).** An earlier draft of this report marked Steps 1–2
> as "blocked / planning only," taken from the program's `000-program/PROGRESS.md`
> tracker (last updated 2026-09-25). **That tracker is stale.** Direct inspection
> of the live Terraform state and the deployed endpoints shows staging was
> re-provisioned after the 09/24 diagnosis and both herobids and Traderton are
> deployed and integrated. The verdict below is based on live evidence, not the
> tracker.

### Live evidence gathered (2026-10-01)

**Herobids staging is up and provisioned.**
- `GET https://staging.openaidom.com/api/health` → **HTTP 200**.
- DNS: `staging.openaidom.com` → `138.199.172.202`.
- Live Terraform state (`herobids/staging/terraform.tfstate`, workspace `staging`)
  — read read-only via the S3 backend — reports:
  - `environment = staging`, `server_ipv4 = 138.199.172.202` (matches DNS + the
    runbook), `nomad_enabled = true`.
  - `private_network_id = 12685156`, `private_network_ip_range = 10.0.0.0/16`
    (the staging CIDR the plan specified, disjoint from production's `10.1.0.0/16`).
  - `agent_node_count = 1`, `agent_node_private_ips = ["10.0.0.3"]`.
  - 9 resources in state: control-plane server, 1 agent node, private network +
    subnet, control-plane + agent server-network attachments, default + agent
    firewalls, SSH key.
- This directly overturns the 09/24 `002-…` diagnostic Pass 1 finding ("state
  serial 76 has zero resources"). The server was clearly re-provisioned since.

**Traderton staging is deployed as an independent, public service.**
- DNS resolves `api.staging.traderton.com` and `staging.traderton.com` →
  `2.28.19.89` — a host **distinct** from herobids' `138.199.172.202`, i.e. the
  separate VM the plan requires. (A direct `curl` from this workstation timed out
  on name resolution; `2.28.19.89` is a Zscaler-range address and the staging docs
  explicitly warn local Zscaler blocks `openaidom.com`/traderton probes — so the
  timeout is a local-vantage artifact, not evidence the service is down. The
  operator confirms both stacks are live on staging.)

**Herobids is wired to consume the Traderton boundary (Step 4 integration config).**
- `infra/hetzner/.env.staging` sets `TRADERTON_BOUNDARY_URL=https://api.staging.traderton.com`
  plus `TRADERTON_BOUNDARY_HMAC_SECRET`, `TRADERTON_BOUNDARY_CONSUMER_ID=herobids`,
  `TRADERTON_BOUNDARY_KEY_ID=herobids-k1`.
- The two repos meet only at a URL + HMAC — the adopted "public/independent" model.
  Confirmed there is **no** `terraform_remote_state` / shared-network handoff to
  Traderton in herobids' `*.tf` (consistent with the superseding note on
  `003-…`).

**Operator runbook exists and is executable.**
- `infra/hetzner/docs/staging-reprovision-runbook.md` (2026-09-27) is a complete
  ordered teardown→provision→setup sequence referencing the real control-plane IP
  and agent private IP `10.0.0.3`, and treats the Traderton boundary as an up
  precondition. The supporting scripts all exist in `infra/hetzner/scripts/`
  (`provision.sh`, `deploy.sh`, `setup-nomad.sh`, `reset-and-run.sh`,
  `smoke-test.sh`, scale-in/out, placement-failure safety net, etc.).

### Step-by-step status (corrected)

| Step | Area | Status | Evidence |
|---|---|---|---|
| 1 | Recover Herobids staging | **Done — live** | `/api/health` 200; 9-resource TF state at `138.199.172.202`; reprovision runbook. |
| 2 | Create Traderton staging infra (independent, public) | **Done — live** | `api.staging.traderton.com` → separate host `2.28.19.89`; herobids has no shared-network handoff. (Traderton's own Terraform lives in the traderton repo, not here.) |
| 3 | Deploy Traderton boundary | **Done (inferred)** | Boundary hostname is live DNS and is a required precondition in the runbook; operator confirms deployed. Pinned release-SHA record not verifiable from this repo. |
| 4 | Integrate Herobids ↔ Traderton | **Config in place** | `.env.staging` boundary URL + HMAC creds set. End-to-end call validation (read tools, `submit_decision`, bot lifecycle, failure mapping) not independently verified here. |
| 5 | Operational readiness & rollback | **Partial** | Runbook + smoke-test + autoscale/scale-in + placement-failure scripts exist. The roadmap's latency/restart/idempotency/soak evidence is not recorded in this repo. |
| 6–8 | Phase 2 (docs move, Traderton frontend, legal/product audit) | **Not started** | No evidence. |
| 9–16 | Phase 3 (generic External Backend refactor) | **Not started** | Confirmed by §3 — concrete `packages/domain/src/traderton/` still in place; no generic `external-backend`/`remote-boundary` code module. |

`004-traderton-production-infrastructure-plan.md` remains entirely **PENDING**
(all five items, "no infrastructure change authorized"); production is a separate
network/VM/state and nothing production-side has landed. `production.tfvars` and
production state were not inspected for this report.

### Why the earlier draft was wrong

The first draft treated `000-program/PROGRESS.md` as authoritative. It is a
hand-maintained tracker that was last written on 2026-09-25, *before* the staging
re-provision. The program's own ENTRYPOINT warns that its summaries "can lag the
live git state" and to verify against actual state — which this correction does.
Lesson: for "is it deployed" questions, verify against live state/endpoints, not
the planning tracker.

---

## Overall assessment

- The two concrete, in-repo bug/feature fixes (09/26 GHCR distribution, 09/27
  Nomad job-spec shape) are **fully implemented**, and 09/27 is covered by passing
  tests. Together they close the last two layers (image distribution + job-spec
  validity) of the staging Nomad incident chain described across the 09/26 and
  09/27 analyses.
- The 09/24 program's **Phase 1 is substantially done and running on staging**:
  herobids staging is live (`/api/health` 200, 9-resource Terraform state at
  `138.199.172.202`), Traderton is deployed as an independent public service
  (`api.staging.traderton.com` on a separate host), and herobids is wired to the
  boundary via `.env.staging` (URL + HMAC). Steps 1–2 are done; Step 3–4
  integration config is in place; Step 5 operational-readiness evidence is only
  partially recorded in this repo. This corrects the earlier draft, which wrongly
  trusted the stale `000-program/PROGRESS.md` tracker.
- The remaining 09/24 work — **Phase 2** (move trading docs, Traderton frontend,
  legal/product audit) and **Phase 3** (the generic External Backend refactor) —
  is **not started**, which §3 confirms: the concrete `packages/domain/src/traderton/`
  module is still in place and no generic `external-backend`/`remote-boundary`
  code module exists.
- 09/23 is a **superseded draft** (correctly not built); its direction lives on in
  ADR 015 and is scheduled as Phase 3.

## Recommended follow-ups (not actioned here)

1. **Rotate the GHCR token** currently in plaintext `infra/hetzner/staging.tfvars`
   (and the `TRADERTON_BOUNDARY_HMAC_SECRET` in `.env.staging`) and move them to a
   secret store; keep tfvars/env files free of live secret values. Both are
   gitignored, but live secrets sit in plaintext on disk.
2. **Refresh `000-program/PROGRESS.md`** to reflect the live staging reality
   (Steps 1–2 done, 3–4 in place) so the tracker stops contradicting deployed
   state.
3. **Record the Step 5 operational-readiness evidence** (latency, restart,
   idempotency, soak, rollback rehearsal) called for by the roadmap, and the
   pinned herobids+Traderton release SHAs (D2), so Phase 1 can be formally closed.
4. When Phase 3 begins, treat ADR 015 (not the 09/23 draft) as authoritative.

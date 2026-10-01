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
| 09/24 | Staging-first External Backend program | **Planning only; execution blocked / mostly in the separate traderton repo** | program tracker |

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
[ADR 015](../../../tech/architecture/adrs/2026/09/015-external-backend-skill-registration.md)
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

## 4. 09/24 — Staging-first External Backend program — PLANNING ONLY

This folder is the program's governing docs (ENTRYPOINT / PROGRESS / DECISIONS)
plus a roadmap and two infra plans. It is sequencing and planning; little of it
is executed code in **this** repo, and what remains is explicitly gated on
operator approval.

Per the program's own `000-program/PROGRESS.md`:

| Step | Area | Documented status | Verified in herobids code |
|---|---|---|---|
| 1 | Recover Herobids staging | 🚫 Blocked (read-only diagnosis done; baseline not restored; awaiting operator decision) | Diagnostic plan `002-…` is read-only; no remediation landed. Matches. |
| 2 | Create Traderton staging infra | 🔄 Code-prepared, apply blocked on approval | Lives in the **separate traderton repo** — there is no `infra/traderton/` in herobids, as the plan's "public/independent model" intends. Cannot verify here; consistent with the doc. |
| 3–5 | Deploy boundary / integrate / readiness | ⬜ Not started | No evidence in code. Matches. |
| 6–8 | Phase 2 (docs, frontend, legal audit) | ⬜ Not started | No evidence. Matches. |
| 9–16 | Phase 3 (generic External Backend) | ⬜ Not started | Confirmed by §3 above (concrete `traderton/` still in place). Matches. |

`003-traderton-staging-infrastructure-plan.md` marks its items 1–3 and 5 as
"DONE (code preparation; live verification pending approval)" and item 4 as
"BLOCKED (requires explicit operator approval)". That prepared code is Traderton-repo
infrastructure (Terraform/cloud-init), not herobids application code, so it is not
present in this repository and could not be verified from here.

`004-traderton-production-infrastructure-plan.md` is entirely **PENDING** (all five
ordered items), status "proposed; no infrastructure change authorized" — nothing to
verify in code, and nothing landed.

**What from this program actually landed in herobids code:** only staging-adjacent
plumbing that overlaps the GHCR work — the GHCR agent-image wiring (§1) and
`infra/hetzner/docs/staging-reprovision-runbook.md`. The core program steps
(staging restore, Traderton deploy, integration, Phase 2/3) have not been executed.

---

## Overall assessment

- The two concrete, in-repo bug/feature fixes (09/26 GHCR distribution, 09/27
  Nomad job-spec shape) are **fully implemented**, and 09/27 is covered by passing
  tests. Together they close the last two layers (image distribution + job-spec
  validity) of the staging Nomad incident chain described across the 09/26 and
  09/27 analyses.
- The two larger items (09/23, 09/24) are **planning/architecture artifacts**. 09/23
  is a superseded draft (correctly not built); 09/24's program is blocked at Phase 1
  Step 1 pending an operator decision, with the generic External Backend refactor
  (Phase 3) not started and the concrete `traderton/` module still in place.

## Recommended follow-ups (not actioned here)

1. **Rotate the GHCR token** currently in plaintext `infra/hetzner/staging.tfvars`
   and move it to a secret store; keep tfvars free of live secret values.
2. **Unblock 09/24 Step 1** — the program needs an explicit operator decision on
   re-provisioning Herobids staging before any further steps can proceed.
3. When Phase 3 begins, treat ADR 015 (not the 09/23 draft) as authoritative.

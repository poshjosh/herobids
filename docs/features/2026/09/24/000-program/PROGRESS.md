# Program Progress Tracker — External Backend / Staging

**Status:** live. **Read this immediately after ENTRYPOINT.md.**
**Updated:** 2026-10-02

## Current state (read first)

**Current phase:** Phase 1 complete; Phase 2 (Steps 6–8) complete (2026-10-02);
**Phase 3 in progress** — Steps 9 and 10 ✅ done 2026-10-02.
**Current step:** **Phase 3 Steps 11–13**, driven by the Phase-3 program package
[`docs/features/2026/10/010-phase3-program/`](../../../10/010-phase3-program/ENTRYPOINT.md).
Start at that package's `TASKS.md` Block 0. **Awaiting operator greenlight to
begin the autonomous run.**

> **Correction (2026-10-02).** This header previously read "next is Phase 3 Step 9
> (Discovery)" while the step table below correctly showed 9 ✅ and 10 ✅. A
> top-down reader started in the wrong place. Fixed.

**Phase-3 scope changed on 2026-10-02 — read ADR 016 + D13–D20 before any Step-11
work.** MCP is now the target invocation transport (superseding ADR 015 §8 and
D4); `McpTransport` and a Traderton MCP server surface are IN scope (D14,
amending D12); the verified descriptor is the sole schema authority (D16); the
write-path idempotency defect is fixed before the rename (D18); REST stays the
default (D19); cross-repo authority is branch-scoped with zero pushes (D20).

**Verified live on 2026-10-01 (supersedes the 2026-09-25 "blocked" state below):**
staging was re-provisioned after the 09/24 diagnosis. The earlier "state serial
76 has no resources" finding is obsolete.
- Herobids staging up: `https://staging.openaidom.com/api/health` → HTTP 200;
  server `138.199.172.202`; live Terraform state has 9 resources, `nomad_enabled=true`,
  private net `12685156` / `10.0.0.0/16`, 1 agent node (`10.0.0.3`).
- Traderton deployed independently on `2.28.19.89` (own postgres/redis/caddy);
  boundary `https://api.staging.traderton.com/health/ready` → HTTP 200 from the
  herobids host.
- Herobids wired to the boundary (`.env.staging` URL + HMAC) — the two meet only
  at a URL, no shared-network handoff.
- Behavioral readiness verified live: fail-closed on outage, ~8–9s recovery,
  idempotent retry, HMAC enforced. See
  [the Phase 1 readiness runbook](../../../../../../infra/hetzner/docs/runbooks/phase1-operational-readiness.md).
- Deployed refs pinned (D2): herobids `a5f403cf`; traderton `41d9c2c1`
  (`ghcr.io/poshjosh/traderton@sha256:b7b93427…`).

**Phase 2 (Steps 6–8): COMPLETE 2026-10-02.** See the Phase 2 program
`docs/features/2026/10/004-phase2-program/` (TASKS/DECISIONS/ESCALATIONS/
RECONCILIATION) and the completion note
`docs/features/2026/10/006-phase2-completion-note.md`. The batched legal
questions (E1/E2/E3) have been resolved by the operator and T4.2 publish has
been executed (`staging.traderton.com` live). No Phase 2 items remain.

**Not started:** Phase 3 (Steps 9–16). The concrete
`packages/domain/src/traderton/` module is still in place; no generic
`external-backend` code module exists yet.

## Step status

Legend: ✅ done · 🔄 in progress · ⏸ paused · ⬜ not started · 🚫 blocked

| # | Step | Status | Notes / handoff |
| --- | --- | --- | --- |
| 1 | Recover Herobids staging | ✅ | Re-provisioned after the 09/24 diagnosis. Live: `/api/health` 200, 9-resource TF state at `138.199.172.202`. Verified 2026-10-01. |
| 2 | Create Traderton staging infrastructure | ✅ | Public/independent model: Traderton on `2.28.19.89` with own postgres/redis/caddy; no shared network. Terraform lives in the traderton repo. Verified live 2026-10-01. |
| 3 | Deploy Traderton boundary | ✅ | Boundary healthy (HTTP 200) over HTTPS via Caddy; image SHA-pinned `sha-41d9c2c1…`. |
| 4 | Integrate Herobids with Traderton | ✅ (config + path verified) | `.env.staging` boundary URL + HMAC; signed read probe reaches auth+routing. Full write-path differential is Step 16. |
| 5 | Operational readiness and rollback | ✅ (behavioral) / N/A (metrics, rollback) | Behavioral checks passed live (fail-closed/recovery/idempotency/HMAC). Metrics N/A (no instrumentation). Rollback N/A pre-launch (teardown+rebuild accepted). See the readiness runbook. |
| 6 | Move trading documentation | ✅ | Phase 2 T3.1/T3.2: venue/wallet/crypto reference docs now canonical in the traderton repo (`docs/reference/*`); herobids glossary split (generic terms only); worker docs-index regenerated. |
| 7 | Build minimal Traderton frontend | ✅ | Phase 2 T4.1: minimal static site (`traderton/site/`) — identity + docs/venue guides + status; execution-boundary isolation tested. T4.2 publish (DNS/TLS/deploy) DONE 2026-10-02 under operator infra greenlight: CI `traderton-site` image + hardened staging `site` service + deploy wiring; `https://staging.traderton.com/` live (200, TLS auto-issued), `/health` + `/internal` → 404 isolation verified, `api.staging.traderton.com/health/ready` → 200. |
| 8 | Audit legal/product boundary | ✅ (modulo legal batch) | Phase 2: frontend audit (003) + backend audit (005); all GENERIC/MOVE/REMOVE-SAFE executed (T1.1/T2.2/T3.2); reconciled (T5.1); the legal/payment product-boundary questions batched in Phase-2 `ESCALATIONS.md` (E1/E2/E3) for one operator decision. |
| 9 | External Backend Genericization Discovery | ✅ | Phase 3. All six ADR-015 Discovery Exit Criteria satisfied in [005-step9-...discovery.md](../005-step9-external-backend-genericization-discovery.md) (2026-10-02): symbol-level disposition for both dirs, importer inventory, descriptor-trust model, end-to-end trace, MCP-deferred comparison, legal/product questions. Step 10 gate satisfied. Key finding: `traderton/` coupling is type-level-only (4 construction sites); real genericization surface = hard-coded trading `if`-branches in skills.ts/provider-catalog.ts/agent-runtime-descriptor.ts/worker. |
| 10 | External Backend contract and trust plan | ✅ | Phase 3. Plan: [006-step10-...plan.md](../006-step10-external-backend-contract-and-trust-plan.md) (2026-10-02). Defines ExternalBackendDefinition (operator registry), ExternalBackendClient rename map, signed ed25519 descriptor + verification/pinning/rotation/revocation, invocation-HMAC-preserved constraint, failure behavior, and ordered tasks for Steps 11–13. Engineering decisions DT1 (asymmetric descriptor sig), DT2 (fixed herobids-owned invocation paths), DT3 (trust-failure → instruction-only degradation). |
| 11 | Generic client migration + transport seam | ⬜ | Phase 3. **Scope changed by ADR 016 / D14:** rename + registry + internal transport seam, with BOTH `RestTransport` and `McpTransport` implemented. Two task groups run FIRST — shared signing-vector fixtures captured against pre-rename code, then the CF-1 write-path idempotency fix (D18). Construction sites corrected to **6 across 3 files** (`worker/index.ts:440,468,502,794`; `worker/agent.ts:938`; `api/index.ts:198`) — Step 9/10 said 5, and `api/routes/exports.ts:348` is a comment. Tasks: Step 10 plan §7 Steps 0/0b/11/11b. |
| 12 | External skill deep integration | ⬜ | Phase 3. Descriptor is the **sole** schema authority (D16/DT4) — a backend's `tools/list` is cross-checked or ignored, never a schema source. This is what makes the step transport-independent, so no rework when MCP lands. |
| 13 | Traderton skill publication | ⬜ | Phase 3. **Dev-signed** descriptor (no ed25519 material exists in any repo; real key is operator-held and gated). Verify against a **local fixture skill source**, NOT `npx skills add` — resolution is live/unpinned from the remote and cannot see local work (D20). Step-12 stub must be DELETED, proven by grep. |
| 14 | Remove Herobids first-party trading ownership | ⬜ | Phase 3 — DEFERRED (D12) |
| 15 | Trading-domain module cleanup | ⬜ | Phase 3 — DEFERRED (D12) |
| 16 | Final staging proof | ⬜ | Phase 3 — DEFERRED (D12) + infra-gated. **Conditional third differential leg** (pinned oracle / REST / MCP) if an MCP transport is reachable when this step is planned; D10 is amended in this step's own verification plan, not earlier. |

## Continuity handoff (for a new agent resuming work)

1. Read [ENTRYPOINT.md](./ENTRYPOINT.md) for objective + invariants.
2. Read [DECISIONS.md](./DECISIONS.md) for decisions made so far — do not relitigate them.
3. Read the current step's plan and resume at the first incomplete sub-step.
4. Do not perform any infrastructure mutation without operator approval.

## Steps completed with evidence

- **Steps 1–5 (Phase 1), verified live 2026-10-01.** Evidence in
  [the Phase 1 operational-readiness runbook](../../../../../../infra/hetzner/docs/runbooks/phase1-operational-readiness.md)
  and [the implementation status report](../../../10/001-implementation-status-report.md).
  Both stacks live and independent, boundary reachable + HMAC-authenticated from
  the real caller, resilience behavior proven, deployed release SHAs pinned.
- Phase 1 is substantially complete. Remaining full-cutover obligations
  (write-path shadow/differential + load) are explicitly deferred to Step 16.

> **On the Phase-1 "has not completed" wording.** §3 of
> [the implementation status report](../../../10/001-implementation-status-report.md)
> still says the staging operational proof "has not completed". That clause sits
> in the section about the **superseded 09/23 draft** and was written from a
> then-stale tracker; §4 of the same document carries the explicit 2026-10-01
> self-correction. The underlying evidence
> ([the Phase 1 readiness runbook](../../../../../../infra/hetzner/docs/runbooks/phase1-operational-readiness.md))
> is unambiguous. **What Phase 3 may assume:** both stacks deployed, independent,
> integrated and healthy, plus behavioural resilience for a READ tool. **What it
> may NOT assume:** write-path differential, load, metrics (no instrumentation
> exists), or rollback.

- **Next:** Phase 3 Steps 11–13 via
  [the Phase-3 program package](../../../10/010-phase3-program/ENTRYPOINT.md).
  **Awaiting explicit operator greenlight before starting the autonomous run.**
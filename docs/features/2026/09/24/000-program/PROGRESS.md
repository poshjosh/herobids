# Program Progress Tracker — External Backend / Staging

**Status:** live. **Read this immediately after ENTRYPOINT.md.**
**Updated:** 2026-10-01

## Current state (read first)

**Current phase:** Phase 1 — Restore And Prove Staging → substantially complete
**Current step:** Phase 1 proven on staging (Steps 1–4 done, Step 5 behavioral
checks done); next is **Phase 3 Step 9 (Discovery)**, which is now unblocked, OR
Phase 2 — awaiting operator greenlight.

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
  [the Phase 1 readiness runbook](../../../../../infra/hetzner/docs/runbooks/phase1-operational-readiness.md).
- Deployed refs pinned (D2): herobids `a5f403cf`; traderton `41d9c2c1`
  (`ghcr.io/poshjosh/traderton@sha256:b7b93427…`).

**Not started:** Phase 2 (Steps 6–8) and Phase 3 (Steps 9–16). The concrete
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
| 6 | Move trading documentation | ⬜ | Phase 2 |
| 7 | Build minimal Traderton frontend | ⬜ | Phase 2 |
| 8 | Audit legal/product boundary | ⬜ | Phase 2 |
| 9 | External Backend Genericization Discovery | ⬜ | Phase 3; starts after Phase 1 operational proof; produces all six ADR 015 exit criteria |
| 10 | External Backend contract and trust plan | ⬜ | Phase 3 |
| 11 | Generic client migration | ⬜ | Phase 3 |
| 12 | External skill deep integration | ⬜ | Phase 3 |
| 13 | Traderton skill publication | ⬜ | Phase 3 |
| 14 | Remove Herobids first-party trading ownership | ⬜ | Phase 3 |
| 15 | Trading-domain module cleanup | ⬜ | Phase 3 |
| 16 | Final staging proof | ⬜ | Phase 3 |

## Continuity handoff (for a new agent resuming work)

1. Read [ENTRYPOINT.md](./ENTRYPOINT.md) for objective + invariants.
2. Read [DECISIONS.md](./DECISIONS.md) for decisions made so far — do not relitigate them.
3. Read the current step's plan and resume at the first incomplete sub-step.
4. Do not perform any infrastructure mutation without operator approval.

## Steps completed with evidence

- **Steps 1–5 (Phase 1), verified live 2026-10-01.** Evidence in
  [the Phase 1 operational-readiness runbook](../../../../../infra/hetzner/docs/runbooks/phase1-operational-readiness.md)
  and [the implementation status report](../../../10/001-implementation-status-report.md).
  Both stacks live and independent, boundary reachable + HMAC-authenticated from
  the real caller, resilience behavior proven, deployed release SHAs pinned.
- Phase 1 is substantially complete. Remaining full-cutover obligations
  (write-path shadow/differential + load) are explicitly deferred to Step 16.
- **Next:** Phase 3 Step 9 (Discovery) is now unblocked; Phase 2 may run in
  parallel. Awaiting operator greenlight before starting either.
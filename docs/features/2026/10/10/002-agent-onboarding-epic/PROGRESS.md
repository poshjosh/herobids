# Progress Checkpoint — Agent Onboarding Epic

**Epic:** [000-roadmap.md](./000-roadmap.md) · **Entry point:** [IMPLEMENTATION.md](./IMPLEMENTATION.md)
**Last updated:** 2026-10-13

> Durable checkpoint so another agent session can resume from the next unfinished item.
> Update this file after each work item / wave / gate.

## Status summary

| Wave | Items | Status |
|---|---|---|
| Wave 1 | WP-A A1/A2/A3-design · WP-H H1–H2 · WP-M Phase 0–1 · WP-C S0 | done |
| Wave 2 | WP-A A3–A6 · WP-B B1–B8 · WP-C S1–S2 | not started |
| Gate G1 | self-serve loop UAT | not started |
| Wave 3 | cut-over (WP-C S3+S4) | not started |
| Wave 4 | channels (WP-M Phase 2–4, WP-C S5.1, WP-E) | not started |
| Wave 5 | cleanup (WP-M Phase 6) | not started |

## Next unfinished item

**Wave 2 → WP-A A3 implementation** (brokered connection-request contract).

## Per-item log

- **2026-10-13 — WP-A A1 DONE.** Error split `precondition.not_ready` → `connection.missing` / `connection.provisioning`. Added `SelectedVenueAccountResolution` to domain tool contract; resolver in `agent.ts` returns discriminated result; `get_risk_limits`/`get_account_summary`/`adjust_risk_limits` updated. Focused tests 23/23 pass; `pnpm lint` green. Committed `613f7ec`.
  - Note: the commit also swept in a pre-existing working-tree deletion of `docs/features/EPIC-INDEX.md` (index for the now-complete parity-drift epic). Flagged for owner awareness.
- **2026-10-13 — WP-A A2 DONE (uncommitted).** `list_providers` registered in base skill and catalog; owner-scoped active connections and agent grants, trading filtered unless explicitly requested or skill present. Shared provider metadata and operator wallet-generation availability feed its output. Provider API tests 7/7, worker registry/domain catalog 56/56, provider tool 4/4, session manager 76/76; `pnpm lint` passed.
- **2026-10-13 — WP-A A3 design DONE.** Brokered capability + typed request/reply for both connection requests and paper trading setup; API session issuance remains API-owned. Detailed seam recorded in WP-A plan.
- **2026-10-13 — WP-H H1–H2/H4 DONE (uncommitted).** One shared trading-profile field derivation with targeted coverage; grant/revoke, delete fan-out, go-live, blueprint, PATCH, and PUT migrated while POST and chat create remain untouched. Seven focused test surfaces passed (316 tests), `pnpm lint` and `git diff --check` passed. Read-only code review found no HIGH or MEDIUM findings. H3 remains WP-B's work.
- **2026-10-13 — WP-M phases 0–1 DONE (uncommitted).** Planned SMS capability and manifest acceptance tests, shared `ChatChannel` port, provider-qualified inbound routing and worker Telegram delivery. Telegram's wire semantics and webhook alias remain intact. Focused routing/manifest tests 13/13, filtered Telegram webhook tests 13/13, `pnpm lint` passed; final read-only review found no findings. The initial full suite identified a stale A2 visibility count (26 vs 27); corrected it and confirmed the 19/19 focused visibility tests pass. Full suite awaits Wave 1 gate rerun.
- **2026-10-13 — WP-C S0 DONE.** Confirmed the plan's name-collision, idle-cost and worker billing-gate constraints; the free-plan config threshold comment was already accurate. No feature code; Wave 1 suite gate pending.
- **2026-10-13 — WAVE 1 GATE PASS.** `pnpm lint` green; `pnpm test`: 330 files passed, 24 skipped; 6508 tests passed, 319 skipped. Wave 2 unblocked; Gate G1 still blocks Wave 3.

## Decisions recorded

_(append dated decisions here)_

## Outstanding issues

_(append LOW/MEDIUM observations from code reviews here)_
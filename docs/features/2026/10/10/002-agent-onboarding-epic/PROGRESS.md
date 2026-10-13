# Progress Checkpoint — Agent Onboarding Epic

**Epic:** [000-roadmap.md](./000-roadmap.md) · **Entry point:** [IMPLEMENTATION.md](./IMPLEMENTATION.md)
**Last updated:** 2026-10-13

> Durable checkpoint so another agent session can resume from the next unfinished item.
> Update this file after each work item / wave / gate.

## Status summary

| Wave | Items | Status |
|---|---|---|
| Wave 1 | WP-A A1/A2/A3-design · WP-H H1–H2 · WP-M Phase 0–1 · WP-C S0 | done |
| Wave 2 | WP-A A3–A6 · WP-B B1–B8 · WP-C S1–S2 | in progress |
| Gate G1 | self-serve loop UAT | not started |
| Wave 3 | cut-over (WP-C S3+S4) | not started |
| Wave 4 | channels (WP-M Phase 2–4, WP-C S5.1, WP-E) | not started |
| Wave 5 | cleanup (WP-M Phase 6) | not started |

## Next unfinished item

**Wave 2 → WP-A A5/A4 (remaining, see [003 plan](../003-dynamic-connections/001-plan.md) implementation log).** Done: completion hook, decline endpoint, expiry sweeper, single-use redeem, web locking + Cancel-as-decline. Open: Gmail OAuth completion (requestId not in OAuth state), `use_existing` approval UI, asker name in the banner, redeem endpoint test, and verifying the runtime re-reads grants on a `connection` wake (G1 UAT).

**Lint caveat:** root `pnpm lint` checks nothing (`files: []`); use the per-project `tsc -p apps/<app>/tsconfig.json --noEmit` checks.
## Per-item log

- **2026-10-13 — WP-A A1 DONE.** Error split `precondition.not_ready` → `connection.missing` / `connection.provisioning`. Added `SelectedVenueAccountResolution` to domain tool contract; resolver in `agent.ts` returns discriminated result; `get_risk_limits`/`get_account_summary`/`adjust_risk_limits` updated. Focused tests 23/23 pass; `pnpm lint` green. Committed `613f7ec`.
  - Note: the commit also swept in a pre-existing working-tree deletion of `docs/features/EPIC-INDEX.md` (index for the now-complete parity-drift epic). Flagged for owner awareness.
- **2026-10-13 — WP-A A2 DONE.** `list_providers` registered in base skill and catalog; owner-scoped active connections and agent grants, trading filtered unless explicitly requested or skill present. Shared provider metadata and operator wallet-generation availability feed its output. (Committed in Wave 1 `919f9ec7`.)
- **2026-10-13 — WP-A A3 design DONE.** Brokered capability + typed request/reply for both connection requests and paper trading setup; API session issuance remains API-owned. Detailed seam recorded in WP-A plan.
- **2026-10-13 — WP-A A3 DONE.** `request_connection` brokered tool shipped end to end (domain schemas, capability grant, broker handler, tool, registry/catalog/BASE_SKILL). Committed `d2667455`.
- **2026-10-13 — WP-A A6 DONE.** Base-skill connection-request instructions block. Committed `d9d0cc1c`.
- **2026-10-13 — WP-A A7 DONE.** `connectionRequests` config block (ttlSecs, maxPendingPerAgent) — shipped with A3.
- **2026-10-13 — WP-H H1–H2/H4 DONE.** One shared trading-profile field derivation; grant/revoke, delete fan-out, go-live, blueprint, PATCH, PUT migrated. (Committed in Wave 1 `919f9ec7`.)
- **2026-10-13 — WP-M phases 0–1 DONE.** Shared `ChatChannel` port, provider-qualified inbound routing, worker Telegram delivery. (Committed in Wave 1 `919f9ec7`.)
- **2026-10-13 — WP-C S0 DONE.** Prerequisite checks confirmed; no feature code.
- **2026-10-13 — WAVE 1 GATE PASS.** `pnpm lint` green; `pnpm test`: 330 files passed, 24 skipped; 6508 tests passed, 319 skipped.
- **2026-10-13 — WP-B B1 DONE.** `testProvisioningDefaults` operator block in traderton + widened `loadOperatorRiskDefaults` in herobids. Committed `e33dbd4` (traderton) + `d31a48b4` (herobids).
- **2026-10-13 — WP-B B2 DONE.** `grantConnectionToRunningAgent` + `connection` wake source. Committed `4683f773`.
- **2026-10-13 — WP-A A5 DONE (API + worker), A4 PARTIAL.** Completion hook on provider-link, decline endpoint, expiry sweeper in `ReminderCoordinator`, single-use redeem, web provider lock + Cancel-as-decline. Open items listed under "Next unfinished item". Committed with this checkpoint.

## Decisions recorded

- **B1:** new top-level `testProvisioningDefaults` key (not extending `agentRiskDefaults`); widened `loadOperatorRiskDefaults` (not a sibling loader).
- **B2:** `allowRunning` flag threaded through prepare/revalidate (default false); shared `executeGrantSaga`; wake callback injected (constructor-injection style), best-effort.
- **A5/A4:** redeem endpoint invalidates the bearer token (single-use) but leaves the record pending until the completion hook finalizes it; wake published via a domain `AgentWakePublisher` port with an API-side Redis XADD implementation.

## Outstanding issues

- **B1 (MEDIUM):** `defaultTestProvider` is an unconstrained free string — constrain to a wallet-generation-capable venue enum before B3/B5 consume it.
- **B1 (LOW):** redundant `get_operator_defaults` test; `as never` casts in tests; capital string→number conversion boundary to confirm in B3.
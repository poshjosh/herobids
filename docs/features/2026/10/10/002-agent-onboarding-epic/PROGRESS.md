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

**Wave 2 — next unfinished item: WP-B B8 (funding info) design decision, then B6, B4/B5, S1, S2.** Done in WP-A: A3–A7 and A4/A5 (completion, decline, expiry, single-use redeem, runtime refresh on completion, Gmail OAuth completion, requesting agent name, provider lock, Cancel-as-decline). Open in WP-A: `use_existing` approval UI; a runtime end-to-end check that the agent uses a new connection on its next tick (G1 UAT). Done in WP-B: B1, B2, B3, B7. Decision needed for B8: the funding read (network, balance) belongs to Traderton, which owns the venue facts; a herobids-local tool would not be visible to agents (trading tools reach agents through the external skill and boundary discovery). Decision needed for B6: trading-skill instructions live in the external `traderton-skills` repo, not in herobids. Decision needed for B4/B5: the worker-to-platform mechanism for `set_trading_setup` (broker plus shared provisioning service vs a second transport).

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
- **2026-10-13 — WP-A A5 DONE, A4 MOSTLY DONE.** Completion hook on provider-link, decline endpoint, expiry sweeper, single-use redeem, runtime descriptor refresh on completion (refresh shared via `services/agent-runtime-refresh.ts`), Gmail OAuth completion via its own cookie, requesting agent name in the banner, web provider lock + Cancel-as-decline. Remaining: `use_existing` approval UI. Commits `5f4a3fda`, `341994ab`, `40478848`, `fbfa7333`.
- **2026-10-13 — WP-B B7 DONE.** Paper/shadow changes only explicitly; grant and revoke no longer change execution mode. Unit and functional tests updated. Commit `053beebf`.
- **2026-10-13 — WP-B B3 DONE.** `grantConnectionToRunningAgent` accepts explicit `changes` (capital, risk, execution), so the first grant provisions a profile with mode and capital. Commit on herobids main (see git log).
- **2026-10-13 — WP-B B8 BLOCKED on design.** See decision above.

## Decisions recorded

- **2026-10-13 — B8 (decided, §5 autonomous):** the funding read is owned by Traderton, since network and balance are venue facts. It is a Traderton read tool that herobids exposes through the agent's trading tool discovery. A herobids-local `get_funding_info` would not be visible to agents, and duplicating the network table would break the single-source rule. Not yet implemented.
- **2026-10-13 — B6 (decided, §5 autonomous):** the trading-skill instructions are edited in the external `traderton-skills` repo (`skills/crypto-trading/SKILL.md`), since herobids holds no trading skill text. Not yet implemented.
- **2026-10-13 — B4/B5 (decided, consistent with A3):** `set_trading_setup` uses the same broker request/reply contract as `request_connection`. The platform-side work (generated connection reuse or create, running-agent grant, profile provisioning) moves into a shared platform service callable by the broker and the API. No second worker-to-API transport. Not yet implemented.
- **2026-10-13 — Stop point:** Wave 2 is not complete. Remaining in Wave 2: B4, B5, B6, B8, S1, S2, `use_existing` UI, and the Wave 2 gate. Waiting for greenlight per the epic's wave rule.

## Outstanding issues

- **B1 (MEDIUM):** `defaultTestProvider` is an unconstrained free string — constrain to a wallet-generation-capable venue enum before B3/B5 consume it.
- **B1 (LOW):** redundant `get_operator_defaults` test; `as never` casts in tests; capital string→number conversion boundary to confirm in B3.
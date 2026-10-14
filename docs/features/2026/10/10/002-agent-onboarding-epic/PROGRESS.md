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

**Wave 2 — next unfinished item: WP-B B4/B5 (`set_trading_setup` and generated-connection reuse), then S1, S2, the `use_existing` UI, and the Wave 2 gate.** Done in WP-A: A3–A7 and A4/A5 (completion, decline, expiry, single-use redeem, runtime refresh on completion, Gmail OAuth completion, requesting agent name, provider lock, Cancel-as-decline). Open in WP-A: `use_existing` approval UI; a runtime end-to-end check that the agent uses a new connection on its next tick (G1 UAT). Done in WP-B: B1, B2, B3, B7. Decision needed for B6: trading-skill instructions live in the external `traderton-skills` repo, not in herobids. Decision needed for B4/B5: the worker-to-platform mechanism for `set_trading_setup` (broker plus shared provisioning service vs a second transport).

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
- **2026-10-13 — WP-B B6 DONE.** Trading-skill guidance in the external `traderton-skills` repo (`skills/crypto-trading/SKILL.md`, commit `9b874f0`): a "Setup and funding" section with the once-per-session defaults question, research-only until the user answers, funding guidance via `get_funding_info`, and the go-live rule (user's own wallet or keys; the agent never switches to live). `get_funding_info` added to the assess list. CHANGELOG updated. No herobids code change; the skill has no tests in this repo, so verification is the agent eval on the end-to-end UAT (G1).
- **2026-10-13 — WP-B B8 DONE (zero-balance go-live warning deferred).** Traderton `get_funding_info` read tool, owner-scoped: funding address, venue network label, latest balance snapshot, and `fundingStatus` (funded | unfunded | unknown). Registered in the provisioning tools and in the crypto-trading `SKILL_TOOL_MAP`. herobids wrapper `get_funding_info` in the account tools, sharing a selected-account read helper with `get_account_summary`; catalog entry added. Tests: Traderton funding-info 7/7; Traderton boundary and tool suites 739 passed; herobids tool and domain suites 1857 passed; worker and boundary type checks clean. Limitations: the balance is the latest trading-actor snapshot, so a new wallet reads `unknown` until the agent trades; a live venue read is a follow-up. The zero-balance warning at go-live (UI and Telegram `/golive`) is not implemented.

## Decisions recorded

- **2026-10-13 — B8 (decided, §5 autonomous):** the funding read is owned by Traderton, since network and balance are venue facts. It is a Traderton read tool that herobids exposes through the agent's trading tool discovery. Implemented; see the B8 log entry.
- **2026-10-13 — B6 (decided, §5 autonomous):** the trading-skill instructions are edited in the external `traderton-skills` repo (`skills/crypto-trading/SKILL.md`), since herobids holds no trading skill text. Not yet implemented.
- **2026-10-13 — B4/B5 (decided, consistent with A3):** `set_trading_setup` uses the same broker request/reply contract as `request_connection`. The platform-side work (generated connection reuse or create, running-agent grant, profile provisioning) moves into a shared platform service callable by the broker and the API. No second worker-to-API transport. Not yet implemented.
- **2026-10-13 — B4/B5 execution plan (decided; not started).** Prerequisite: the trading-profile reconciliation code (`trading-profile-reconciliation.ts`, `-saga.ts`, `-adapter.ts`, `trading-profile-fields.ts`, `profile-scan-config.ts`, ~1,000 lines with tests) lives in `apps/api/src/agents`. The worker cannot reach the running-agent grant without it, and `set_trading_setup` needs the grant. Steps, each with its own gate:
  1. Move those modules and tests into `packages/db/src/trading-profiles/` (packages/db already hosts the reconciliation outbox). Add `@poshjosh/contracts` to packages/db only if the saga needs it. Rewrite about 30 importers in apps/api. Gate: `tsc` for db, api and worker; api `services` and `agents` tests.
  2. Shared platform service `setupTradingForAgent` (in packages/db), injected with the boundary client, saga, and wake. Called by the broker and the API. Gate: unit tests for reuse, create, grant and changes.
  3. Broker message `agent.manage_trading_setup` (domain schema, `MESSAGE_PAYLOAD_SCHEMAS`), capability grant in `capability-policy.ts`, handler in `agent-message-broker.ts`, tool `set_trading_setup` in `tools/connections.ts`, and registration in `KNOWN_AGENT_TOOL_NAMES` and `TOOL_CATALOG`. Gate: tool catalog assertion; tool tests including ceiling violation.
  4. B5 reuse-or-create: reuse an active generated connection for the default test provider before provisioning through the boundary (`provision_venue_account`, generate mode). Plan-limit errors are returned in plain words. Gate: free-plan test.
- **2026-10-13 — B4 step 1 DONE (`6835b03d`).** Trading-profile reconciliation (planner, saga, adapter, fields, scan config, with tests) moved to `packages/db/src/trading-profiles/`. `@poshjosh/contracts` and `zod` added to packages/db. The API keeps re-export shims at the old paths so importers and test mocks stay valid; rewriting importers to `@herobids/db` is a follow-up. Architecture guard updated to scan the db definitions.
- **2026-10-13 — B4 step 2a DONE (`1cd7c3f3`).** Running-agent grant service (`grantConnection`, `grantConnectionToRunningAgent`, `revokeConnection`, `listAgentConnections`) moved to `packages/db/src/agents/agent-config-service.ts` with its test. API shim kept. Worker can now call the grant directly.
- **2026-10-13 — B4 step 2b DONE (`4d4aa9ea`).** Plan guards (`checkVenueAccountLimit`, `checkConnectionLimit`, and related) moved to `packages/db/src/plan-guards.ts`. API shim re-exports them with the domain resolvers.
- **2026-10-13 — B8 manifest fix.** `get_funding_info` row added to the tool-ownership manifest (`external:trading`); this was missing from the B8 commit and failed `providers.test.ts`.
- **Gate status (after 2b):** `packages/db`, `apps/api` and `apps/worker` tests: 229 files passed, 4611 tests passed. `tsc` clean for db, api and worker.
- **2026-10-14 — B4 step 2c DONE (`9ebfe2f0`).** Trading provider link (`createTradingProviderLink`, `compensateProvision`, `parseProvisionedWallet`) moved to `packages/db/src/trading-setup/`. The API setup route calls it with an injected logger; the generic credential path stays in `setup.ts`.
- **Next unfinished item: B4 step 2d.** `setupTradingForAgent` needs the operator defaults (boundary `get_operator_defaults`) and a wallet network label. The network mapping lives in the API providers registry, which the worker cannot import, so move or inject it first. Then reuse-or-create (B5), the running grant with `changes`, and a summary. Then step 3 (broker message, capability, `set_trading_setup` tool), S1, S2, the `use_existing` UI, and the Wave 2 gate. Move `createTradingProviderLink`, `parseProvisionedWallet` and `compensateProvision` out of `apps/api/src/routes/setup.ts` (about lines 324–514) into `packages/db/src/trading-setup/`, so both the API route and the new `setupTradingForAgent` call the same generated-connection creation. Then B4 step 2d: `setupTradingForAgent` (operator defaults, reuse-or-create, running grant with `changes`, summary). Then step 3 (broker message, capability, `set_trading_setup` tool), B5 reuse, S1, S2, `use_existing` UI, and the Wave 2 gate.

## Outstanding issues

- **B1 (MEDIUM):** `defaultTestProvider` is an unconstrained free string — constrain to a wallet-generation-capable venue enum before B3/B5 consume it.
- **B1 (LOW):** redundant `get_operator_defaults` test; `as never` casts in tests; capital string→number conversion boundary to confirm in B3.
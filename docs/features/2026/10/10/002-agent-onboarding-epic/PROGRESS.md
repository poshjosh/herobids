# Progress Checkpoint — Agent Onboarding Epic

**Epic:** [000-roadmap.md](./000-roadmap.md) · **Entry point:** [IMPLEMENTATION.md](./IMPLEMENTATION.md)
**Last updated:** 2026-10-14

> Durable checkpoint so another agent session can resume from the next unfinished item.
> Update this file after each work item / wave / gate.

## Status summary

| Wave | Items | Status |
|---|---|---|
| Wave 1 | WP-A A1/A2/A3-design · WP-H H1–H2 · WP-M Phase 0–1 · WP-C S0 | done |
| Wave 2 | WP-A A3–A7 · WP-B B1–B8 · WP-C S1–S2 | items done; gate run 2026-10-14; deferred follow-ups listed under "Not verified or deferred" |
| Gate G1 | self-serve loop UAT | Waived by owner 2026-10-15: treated as passed for the cut-over; trade and go-live steps not run. Partial PASS (see G1 log below); rerun 2026-10-15 passes link, wake, wallet and account/funding tools (see G1 rerun below). Not passed: trade in test mode and go-live with a cloned agent not run |
| Wave 3 | cut-over (WP-C S3; S4 replaced by guided chat removal) | **Done 2026-10-23 (owner).** Form calls `POST /agents`; guided chat removed; shared create core deferred; trading fields stay in the form until the Traderton-hosted form exists. Tests run by owner after each tag since 0.7.2. |
| Wave 4 | channels (WP-M Phase 2–4, WP-C S5.1, WP-E) | not started |
| Wave 5 | cleanup (WP-M Phase 6) | not started |

## Next unfinished item

**Next unfinished item: R6, then Gate G1.** The 2026-10-15 rerun (below) passes the link, wake, wallet and account/funding steps on the new flow; the trade and go-live steps remain. Rerun G1 on the new flow (blank agent, trading skill, `request_connection`, link, wake, paper trade with the agent stating mode and capital, then edit capital while stopped and restart), then the link/wake loop and go-live with a cloned agent. Record each result in the G1 table with evidence the same turn it is reported. G1 must pass before Wave 3 starts; Wave 3 needs owner greenlight. **R1–R5 are implemented and tested but uncommitted in three repos** (herobids, traderton, traderton-skills); Traderton R1 must ship before the herobids removal is used; no deployment without approval. Rerun G1 on the new flow (blank agent, trading skill, `request_connection`, link, wake, paper trade with the agent stating mode and capital, then edit capital while stopped and restart), then the link/wake loop and go-live with a cloned agent. Record each result in the G1 table with evidence the same turn it is reported. G1 must pass before Wave 3 starts; Wave 3 needs owner greenlight. **R1–R5 are implemented and tested but uncommitted in three repos** (herobids, traderton, traderton-skills); Traderton R1 must ship before the herobids removal is used; no deployment without approval.

**Wave 2 follow-ups still open (not blocking G1 by themselves; see "Not verified or deferred"):** route-level test for `POST /setup/connection-requests/:id/use-existing`; zero-balance go-live warning (B8); `update_my_prompt` journal entry (owner deferred); DB-backed functional suites (agents, go-live) need Postgres and have not run; Traderton `ceiling violation` test not re-run here.

**Done in Wave 2 (per-item log):** WP-A A3–A7 (`request_connection`, completion, decline, expiry, single-use redeem, runtime refresh, `use_existing` approval). WP-B B1–B5, B7, B8 (B8 without the zero-balance warning). WP-B B6 is in the external `traderton-skills` repo. WP-C S1 (optional name, `update_my_prompt`, first-turn guidance) and S2 (in-app conversation).

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
- **2026-10-16 — Blank-goal first-turn rule removed (owner decision).** `FIRST_TURN_GOAL_GUIDANCE` told a blank-goal agent to restate the creator's first request as its goal with `update_my_prompt`. An agent turned "help me trade crypto" into a too-specific goal and then said it could not change it. The rule is gone. A blank job now shows `EMPTY_JOB_DEFAULT_TEXT`, which also tells the agent to ask what the user wants. A set job is followed by `JOB_CHANGE_GUIDANCE`: the creator can change it, ask whether to replace or add, use their own words, call `update_my_prompt` only after they answer. The tool descriptions say the same. Tests: domain `agent-goal`, worker `runtime-composition` and tool suites pass.

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
- **2026-10-14 — B4 step 2d DONE (`beb8ee35`).** `setupTradingForAgent` in `packages/db/src/trading-setup/` reuses an active connection on the default test provider, otherwise creates a generated test wallet via the shared link. It grants with paper mode and the requested or default capital, and never sets live. Decision: reuse any active connection on that provider (no provenance column exists), which is safe because paper mode never signs. Network labels moved to `WALLET_NETWORKS` in `@herobids/domain`; the API registry uses them. Gate: 6 service tests, db/domain/API/worker suites 5703 passed, tsc clean.
- **2026-10-14 — WAVE 2 ITEMS DONE and gate run.** B4 step 3 (`8397ef7a`): brokered `set_trading_setup`. B5: reuse and plan-limit errors in plain words (service and tool tests). S1 (`8f1a9005`, `1bf1e991`, `882361e0`): optional agent name with unique `adjective-noun` allocation; brokered `update_my_prompt`; first-turn goal guidance. S2 (`2619ce5a`): conversation on the agent detail page (composer disabled unless running; i18n in en/ar/hi). `use_existing` (this commit): `POST /setup/connection-requests/:id/use-existing`, the callback carries `mode`, and the provider-link page lists the user's active connections for confirmation.
- **Wave 2 gate (2026-10-14):** `tsc` clean for db build, API, worker, web. Backend suites (db, domain, API, worker): 276 files, 5,715 tests passed. Web setup, agents and i18n suites: 35 files, 556 tests passed.
- **Decisions made this wave (§5):** (1) network labels live in `WALLET_NETWORKS` (domain). (2) `set_trading_setup` reuses any active connection on the default test provider, since no provenance column exists; paper mode never signs, so this is safe. (3) `set_trading_setup` takes `capital` only; `riskPosture` is deferred. (4) The base-tool visibility budget was raised 28 → 29 → 30 for `set_trading_setup` and `update_my_prompt`; it is pinned in `runtime-tool-visibility.test.ts`.
- **Not verified or deferred (must be carried into G1, not claimed done):** the broker handler branches for `set_trading_setup` and `update_my_prompt` have no direct broker unit test (their tool and service paths are tested). `update_my_prompt` writes `agents.prompt`, but the journal entry from the plan is not written, and "takes effect on the next run" is unproven. The `use-existing` route has no route-level test. The web create form still requires the agent name and does not yet use the optional name or the "Configure employe" step. The DB-backed functional suites (agents, go-live) need Postgres and were not run. Traderton's `ceiling violation` test lives in the Traderton repo and was not re-run here.
- **Greenlight requested for Wave 3** after the G1 self-serve UAT is recorded. Wave 3 has not started.
- **2026-10-14 — Connection-flow rework (owner decisions; code uncommitted).** (1) All connections are treated the same: no "test wallet" class, label or wording. (2) `set_trading_setup` no longer creates or picks a connection; it sets capital and paper mode on the trading connection already granted, else fails with `connection.missing`. (3) The `request_connection` link page offers use-existing (only if the user has any), enter details, and create (where the provider supports it); the `mode` parameter is removed from the tool, the protocol, the request record and the callback redirect. (4) Connection-request links keep the login token (private message). (5) Prompts stay generic: no wallet or trading wording in the base prompt; trading wording lives in the `traderton-skills` crypto-trading skill. (6) Live starts only from a user action (web or Telegram `/golive`), never the agent; the word "UI" is dropped from the invariant. Plans amended: WP-B and WP-A plans, IMPLEMENTATION §3.2 (1, 3) and D-B2. Verified: `tsc` clean for db, domain, api, worker, web; 18 focused test files, 363 tests passed.
- **2026-10-14 (owner) — safe defaults live in Traderton; `set_trading_setup` is to be removed (not yet implemented).** Traderton writes paper mode and the operator default capital into the stored profile at first creation. The values must show in the user's edit form and the user can change them (own agent values only); nothing marks them as defaults. Details, the removal list and the proposal to reuse `execution.defaultOwnerMode` are in the WP-B plan.
- **Owner-confirmed 2026-10-14 (corrects an earlier wrong finding):** the edit form already shows capital (main form) and execution mode (Advanced Settings → Capabilities). No existing rule or process changes; editing stays limited to stopped or crashed agents.
- **2026-10-14 (owner) — ask-once question dropped (option A).** The agent trades in paper mode with the defaults after the connection is granted and tells the user once what is in effect. Not yet implemented; the implementation plan (R1–R6) is in the WP-B plan and awaits owner approval.
- **2026-10-14 (owner) — implementation approved (R1–R3, R5–R6; R4 done last).** Swap venues default to shadow. Block name `testProvisioningDefaults` kept. The mode default is a new constrained key `defaultTestMode` (paper or shadow), not `execution.defaultOwnerMode`, which allows live.
- **2026-10-14 — R1–R5 implemented (uncommitted).** Traderton: defaults applied when a profile row is first created (tool plus repository insert branch), swap venues fall back to shadow, no capital default for a live profile; the two dead config fields removed. Full suite 170 files, 2,990 tests passed, 108 skipped. Herobids: `set_trading_setup` stack removed (tool, broker message, schemas, capability, catalog and base-list entries, setup service, defaults loader, test-provisioning schema, the unused grant `changes` option); full suite 339 files, 6,585 tests passed; `tsc` clean for db, domain, api, worker, web. Skill text rewritten in `traderton-skills`. Details in the WP-B plan.
- **Not verified (carry into R6, do not claim done):** (1) the Traderton repository test for first-creation-only and replay is written but was not run (no Postgres, `DATABASE_URL` unset); (2) the agent's "Execution mode" context line was always `paper`; the owner chose to remove it (option B, done 2026-10-14, full herobids suite 339 files and 6,585 tests passed); the descriptor's `executionMode` field is left in place; (3) a trading agent created through `POST /agents` with an explicit `capital: null` would now get the default capital at first profile creation; (4) the web app and API behaviour end to end on a live stack was not exercised.
- **2026-10-16 (owner) — agents do not write their own goal.** Reverses the WP-C S1 first-turn rule and the D-C6 wording "durable goal is the agent's job". The creator sets the goal, or tells the agent to change it, in their own words. Effect on G1: the blank-agent and specifics-path evidence (2026-10-14 and 2026-10-15) was gathered under the old rule, so its first-turn goal step no longer applies. A fresh run is needed if G1 is re-gated. Not run.

## G1 log (local docker compose, 2026-10-14)

Result: Partial PASS

| G1 step | Result | Evidence |
|---|---|---|
| Blank agent gets "Help me trade crypto" and replies | **Pass** | Inbound wake 20:01:08 (`trigger: wake`, reason `user_message`); reply sent 20:06:19 (`agent.message.send`) |
| `connection.missing` on a trade tool | **Pass** | `get_account_summary` and `get_risk_limits` at 20:01:38 returned "no trading connection is set up yet" |
| `list_providers` | **Pass** | `list_providers` (capability `trading`) at 20:03:29 returned `hyperliquid` |
| `request_connection` returns a link | **Pass** | Request `2d6b34f7-4db9-49b6-84ef-de24d6d8f193` at 20:06:16; link sent at 20:06:19 |
| Trading skill assigned | **Pass** | `add_skills` at 20:01:17 added `traderton/skills/crypto-trading`; `agent_skills` shows it |
| Trading skill guidance loaded | **Not met** | `read_skill` at 20:01:25 and 20:08:34 returned "not installed in this workspace". The guidance never loaded. |
| Link completed | **Pass** | Redis request `status: completed`; connection `8b3845d1-…` (`my-hyperliquid-wallet`, hyperliquid, active) granted 20:08:08 |
| Agent woken after completion | **Not met** | No wake with source `connection` after 20:08:08. The next tick at 20:08:23 had reason `scheduled_check_in`. |
| `update_my_prompt` persisted | **Partial** | Call at 20:01:35 returned `ok`, length 483; `updated_at` 20:01:35. The text is a reworded version of the seed, so not yet proven to be the agent's own goal. |
| Trade in test mode | **Not run** | No `submit_decision`, decision or position in the log |
| Go-live with a cloned agent | **Not run** | Out of G1 scope |

## G1 rerun (local docker compose, 2026-10-15)

Runs use the config-update discovery fix and the skill-activation change (uncommitted at the time of the runs). Each cycle was run with `scripts/ts/run-connection-cycle.ts`: create a user and agent, message the agent, redeem its link, complete the connection through `POST /setup/provider-link`, then send a follow-up asking for the account and funding tools. Evidence is from the database (`agent_messages`) and the agent container log.

| G1 step | Result | Evidence |
|---|---|---|
| Blank agent receives the goal and replies | **Pass** | Agent `05f43e01` (14:06); reply sent 14:06:42 |
| Trading skill assigned and loaded | **Pass** | Agent `b7e3bf28`: `load_skill` returned `loaded: true`, `available: true` at 13:57:16 |
| `request_connection` returns a link | **Pass** | Agent `45325b06`: link redeemed and exchanged by the script (request `8282581e`, 14:08) |
| Link completed | **Pass** | Request `status: completed`; wallets created: `0x8810…0ea1` (`05f43e01`), `0xB057…f647` (`45325b06`) |
| Agent woken after completion | **Pass** | Agent `b7e3bf28`: tick at 13:57:38 with `trigger: wake`, `hasWakeSignal: true`; reply at 13:57:44 about the approved connection |
| Account mode and capital read by the tool | **Pass** | `get_account_summary` returned `ok: true`, `executionMode: paper`, `capital: 1000` (`05f43e01` 14:06:39; `45325b06` 14:08:47) |
| Funding address read by the tool | **Pass** | `get_funding_info` returned `ok: true`; address matches the created wallet (`05f43e01`, `45325b06`) |
| No tool rejections | **Pass** | Zero "Tool not in active skill set" lines for `05f43e01` and `45325b06` |
| Trade in test mode | **Not run** | No `submit_decision` run |
| Go-live with a cloned agent | **Not run** | Out of this rerun |

Automated check: `scripts/shell/tests/connection-cycle-test.sh` (run by `run-all-tests.sh --e2e`) passed as agent `7b0c0bbb` at 14:16 (`verdict: PASS`, both tool results `ok: true`, wallet present, reply present).

Known gaps: the zero-balance warning is not built; `fundingStatus` stays `unknown` until the agent trades or is funded.

Known gaps G1 depends on:
- `update_my_prompt` has no journal entry (deferred by the owner).
- Zero-balance go-live warning not built (B8 follow-up).
- Broker branch tests for the two new message types were missing; denial-reply tests now added (`aa43f8af`).
- **Rerun needed after the 2026-10-14 connection-flow rework:** the rows above for the trading skill, connection grant and paper setup passed against the old `set_trading_setup`, which created and reused wallets itself. They must be rerun against the new flow (`request_connection` first, then `set_trading_setup`).

- **Superseded (done):** B4 step 3 plan, kept for history: Verified facts: the broker is constructed only in `apps/worker/src/index.ts`. The trading write client is created inside the `sideEffectBoundary` IIFE (around line 439), so it must be hoisted into a shared `tradingClient`. The broker has `db` and `sideEffectBoundary` but not the client. Defaults must come through the worker's read boundary (`ctx.externalBackend.invoke`, mapped to a read result) or a `loadTestProvisioningDefaults` helper. The API loader (`apps/api/src/traderton-operator-defaults.ts`) takes a `TradertonReadBoundary` and is not shared yet. Edits: protocol constant, payload and result schemas, `MESSAGE_PAYLOAD_SCHEMAS`; `KNOWN_AGENT_TOOL_NAMES`, `TOOL_CATALOG` and BASE `requiredTools`; `capability-policy` brokered grant; `publishTradingSetupReply` on the event publisher; broker switch case, optional `tradingSetup` constructor param appended last, and a `handleManageTradingSetup` method with the same trading-capability gate as `request_connection`; `set_trading_setup` tool that BLPOPs the reply; registration in the tools index; manifest row (`external:trading`); tests for the tool and broker branches.
- After step 3: B5 (reuse is in place; add the plan-limit plain-words test), S1, S2, the `use_existing` UI, and the Wave 2 gate. Move `createTradingProviderLink`, `parseProvisionedWallet` and `compensateProvision` out of `apps/api/src/routes/setup.ts` (about lines 324–514) into `packages/db/src/trading-setup/`, so both the API route and the new `setupTradingForAgent` call the same generated-connection creation. Then B4 step 2d: `setupTradingForAgent` (operator defaults, reuse-or-create, running grant with `changes`, summary). Then step 3 (broker message, capability, `set_trading_setup` tool), B5 reuse, S1, S2, `use_existing` UI, and the Wave 2 gate.

## Owner waiver and decisions (2026-10-23)

- **Wave 1 gate status (owner, 2026-10-24).** Wave 1 is passed. The "blocked" note in the [WP-M plan, Phase 1 record](../007-multi-provider-chat-messaging/900-implementation-plan.md) came from an earlier run and is superseded by "WAVE 1 GATE PASS" (2026-10-13, line 41 above).

- **Gate G1 waiver (owner):** all outstanding G1 items are waived for Wave 3 and beyond. Agents are actively trading on staging. Go-live has not been tested and is accepted as an open risk.
- **D-C4 amended (owner):** auto-start is kept. New agents start on creation (commit `b5ea3952`).
- **Working tree:** owner confirms no uncommitted herobids changes.
- **Cut-over gate amended (owner, 2026-10-23):** trading fields (execution mode, venue, trading guardrails, trading auto-select in the connection picker) stay in the create form for now. The connection picker stays generic. Future: trading setup is shown in a form hosted by Traderton, like a payment provider's hosted form. The "no trading references in the form" criterion is removed from IMPLEMENTATION, the roadmap, and the wave 3 README. Plan [004](../../15/001-wave3-cutover/004-trading-removal-from-creation.md) is deferred.
- **Next:** Wave 3 cut-over (WP-C S3 form change, per [006 plan](./../006-simplified-agent-creation/001-plan.md)), then Wave 4.

## Outstanding issues

- **B1 (LOW):** redundant `get_operator_defaults` test; `as never` casts in tests; capital string→number conversion boundary to confirm in B3.
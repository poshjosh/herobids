# Plan: Trading Provisioning for an Agent That Starts Blank (WP-B)

**Status:** draft
**Created:** 2026-10-10
**Epic:** [002-agent-onboarding-epic/000-roadmap.md](../002-agent-onboarding-epic/000-roadmap.md)
**Depends on:** [dynamic connections](../003-dynamic-connections/000-discovery.md) (WP-A) for the live-mode link; [harmonize create/update paths](../004-shared-profile-derivation/000-analysis.md) (WP-H) for the shared profile derivation.

## Problem

A blank agent that adds the trading skill (via `add_skills`) cannot trade. In the observed session `get_risk_limits` returned "selected trading account is unavailable". Once the connection exists the problem remains: nothing sets capital, execution mode or risk. This plan defines how the agent ends up with a usable trading setup, with the user in control.

## Verified facts (checked in code, 2026-10-10)

1. **Test mode needs a venue account.** Every trading call that resolves a venue (`submit_decision`, bots) fails with `precondition.not_ready: no venue account for owner` when none exists (`traderton/packages/boundary/src/subject-resolver.ts`). herobids resolves the account from an active `agent_connections` row whose connection has `resolvedVenueAccountId` (`apps/worker/src/agent.ts` ~L1850). So paper/shadow also needs a connection.
2. **A generated-wallet connection needs no user input.** `createProviderLink(..., credentialMode: 'generated')` provisions a venue account in traderton (`provision_venue_account`, generate mode) and stores the connection (`apps/api/src/routes/setup.ts`). `venues.hyperliquid.walletGeneration.enabled` is true by default. It is subject to plan connection limits. Today only the guided chat calls it (`create_connection`); no agent tool exposes it.
3. **"Test" is an alias, and paper works with a connection.** The UI shows only live/test; test resolves to paper (no connection) or shadow (connection). In traderton, paper "requires no venue adapter or credentials" (`agent-trading-actor.ts`), and neither the actors, executors nor the risk limits read a wallet balance (sizing comes from the profile capital). So a fresh unfunded wallet works in paper and in shadow. In herobids an explicit canonical `paper` is accepted even with connections, and only `shadow`/`live` require one (`validateConnectionRequirement`). The single obstacle is the carry-forward rule in `resolveExecutionModeForSkills` that silently flips `paper` to `shadow` whenever the agent has a connection (and back), asserted by functional tests and the glossary. Swap venues (jupiter, 1inch) cannot run paper; hyperliquid can.
4. **An empty profile is unusable.** Granting a connection with no existing profile creates one with capital, risk and execution mode all null ("never synthesize a default profile", `trading-profile-reconciliation.ts`). Traderton then fails: the actor ensure throws "selected agent trading profile has no execution mode" and `get_risk_limits` throws when the profile is missing. A null capital alone is tolerated by the risk calculator (parity tests); a missing mode is not.
5. **No server-side default capital exists.** Only the frontend hardcodes `'1000'` (`AgentsPage.tsx` L300). Traderton owns operator risk defaults (ADR 011); `get_operator_defaults` returns the `agentRiskDefaults` block, which has no capital. These defaults are also the ceilings for `set_agent_trading_profile`.
6. **Granting a connection requires a stopped agent**, enforced in `agent-config-service.ts` (`agent_not_stopped`, re-checked inside the transaction). The rule was introduced when the shared services were extracted (commit 908ac6c9) "consistent with the HTTP API's PUT/PATCH constraint" and the Telegram config commands plan. No runtime reason is documented for connections; for config in general the only rationale is a code comment on PATCH ("the running process has already loaded its config"), which holds for prompt and limits but not for connections, which the worker hot-reloads. Evidence the runtime can cope with a running agent: the worker already hot-reloads the connection part of its descriptor (`onSkillsChanged` re-reads `grantedConnectionsByFamily`, readiness and default connection), venue-account lookups for decisions and risk reads are fresh DB reads per call, and traderton rebuilds the agent actor when the profile revision changes.
7. **Live mode is already gated.** Mode changes to live are rejected by PATCH/PUT/Telegram; the only route is `POST /agents/:id/go-live`, which clones the agent as live and requires an active connection and a plan with live enabled.

## Decisions (owner, 2026-10-10)

- Both paths are supported. If the user has said nothing about it, the agent asks whether they want it to **pick safe defaults** or to **set the specifics themselves**.
  - Defaults (path C): the platform provisions a test-mode setup from operator defaults.
  - Specifics (path A): the user tells the agent capital and risk, and the agent applies them.
- Both paths use **one tool** and one server-side code path; path C is the same call with no values.
- Neither path can enable live mode. Live is started by the user (go-live in the web app or `/golive` in Telegram), never by the agent. *(Amended 2026-10-14: was "an explicit UI confirmation".)*
- The setup pins the agent to **paper** (fully simulated). *(Amended 2026-10-14: the clause "on a generated wallet that is never funded for test purposes" is withdrawn; see the connection decisions below.)*
- The agent tells the user the wallet is unfunded and must be funded before live, at setup and again every time the user asks to go live.
- **2026-10-14 (owner): connection-request links carry a login token.** The link is in a private message to the user, so it keeps the `request_connection` token properties (D-A1: short-lived, single-use). The earlier idea of a separate wallet-details link is dropped: the flow below needs no such link.
- **2026-10-14 (owner): all connections are treated the same.** No special class, label or wording for a platform-created wallet. The stored label of a connection is whatever the link page gives it, like any other.
- **2026-10-14 (owner): the setup tool no longer creates or picks a connection.** `set_trading_setup` sets capital and paper mode on the trading connection already granted to the agent; with none it fails with `connection.missing`. The agent gets a connection through `request_connection`, never from this tool. *(Superseded later on 2026-10-14: the tool is removed; see below.)*
- **2026-10-14 (owner): the request link page offers the three choices together.** Use an existing connection (shown only if the user has any for the provider), enter details, or create one for the user (only where the provider supports it). `request_connection` has no `mode` parameter.
- **2026-10-14 (owner): prompts stay generic.** The base prompt says nothing about wallets or trading. Trading and wallet wording lives in the trading skill (`traderton-skills`) and the trading tools.
- **2026-10-14 (owner): safe defaults live in Traderton, and `set_trading_setup` is removed.** When a trading profile is first created for an agent with no mode or capital supplied, Traderton writes paper mode and the operator default capital into the stored profile (creation only, never on later updates). Conditions: the values show in the user's edit form, and the user can change them (the user's own agent values, not the operator-wide defaults). Nothing marks them as defaults in the UI. To be removed from herobids: the `set_trading_setup` tool, its broker message, protocol schemas, capability, catalog and base-list entries, `setupTradingForAgent` and the herobids defaults loader. This also withdraws the agent-side way to set capital. **Not yet implemented.** Proposal, not yet confirmed: reuse Traderton's existing `execution.defaultOwnerMode` (paper, `config/default.yaml`) for the mode default.
- **Owner-confirmed 2026-10-14 (corrects an earlier wrong finding):** the edit form already shows capital (main form) and execution mode (Advanced Settings → Capabilities); nothing is missing. An earlier read-only trace concluded the form could not show stored profile values; that was wrong or incomplete, and the real data path was not traced. No existing rule or process changes: `PATCH /agents/:id` still accepts config changes only when the agent is stopped or crashed. Traderton creates the profile row in `agent-trading-profile-repository.ts` (`applyOperation`, insert at line 204), not yet read in detail.
- **2026-10-14 (owner): the ask-once question is dropped (option A).** After the connection is granted the agent trades in paper mode with the defaults and tells the user once what is in effect (mode and capital), and that changing them means stopping the agent, editing its settings and starting it again. There is no "research only until answered" gate and no agent-side way to set capital. Amends D-B1. **Not yet implemented.**
- **2026-10-14 (owner): implementation approved (R1–R3, R5–R6; R4 treated as approved, done last).** Swap venues (Jupiter, 1inch) default to **shadow**, because agents cannot run paper there. The agent decides the block name: `testProvisioningDefaults` is kept (renaming touches two repos for little gain). **Agent design note:** the mode default is a new constrained key `testProvisioningDefaults.defaultTestMode` (`paper` or `shadow`), not `execution.defaultOwnerMode` as first proposed, because `defaultOwnerMode` also allows `live` and is a ceiling for the escalation guard, so reusing it could create live profiles if misconfigured.
- **Open (2026-10-14):** none outstanding beyond the implementation items below.

## Design

### Agent-facing flow

*(Superseded 2026-10-14: the ask-once step and the `set_trading_setup` call are removed; see the decisions above and the revision section below.)*

1. The agent adds the trading skill. The trading skill's instructions tell it: before any trading action, ask once: "Want me to pick safe defaults (test mode with simulated money), or do you want to set capital and risk yourself?" Persist the answer in the agent's memory so it is not asked again. No trading action before it is answered; research and market reads are fine.
2. The agent calls `set_trading_setup`.

### Tool: `set_trading_setup`

*(Superseded 2026-10-14: the tool is to be removed; Traderton applies the defaults at profile creation.)*

- Params: `capital?`. Omitted values come from operator defaults. No `mode` param: the mode set is always `paper`.
- Server-side steps, in one saga (reuses the profile reconciliation saga and, after WP-H, the shared derivation):
  1. Find the trading connection already granted to the agent (active, resolved venue account). If none, fail with `connection.missing` (*amended 2026-10-14: the tool no longer creates or reuses connections*).
  2. Re-grant it to the agent with the explicit `changes` (new running-agent path, see below), which applies capital and paper mode.
  3. Provision the profile via `proposeTradingProfiles` with `changes = { capital, riskPosture, executionDefaults }`. Today grant passes `changes: {}`, which is what produces the empty profile.
  4. Return a summary the agent reads to the user: mode, capital, effective risk limits, how to change them (edit form, or tell the agent), how to go live.
- Risk values may only be at or below the operator ceilings (enforced by traderton; Agent Mode Purity: operator defaults are agent-mutable downward). Anything the user wants looser or locked is done in the edit form, which stores user-configured, immutable limits.
- The tool is invoked from the worker; the connection creation and grant live in the API. This needs the same worker-to-API mechanism as WP-A's `request_connection` (decide once, see roadmap F3).

### Running-agent grant

Add a dedicated path (not a blanket removal of the stopped rule) used only by `set_trading_setup` and the WP-A link completion:
- Allowed while the agent is running; skips the `agent_not_stopped` check but keeps ownership, activeness and the in-transaction revalidation.
- After commit, signal the agent to refresh its descriptor (the same re-read `onSkillsChanged` performs) and wake it.
- All other callers (PATCH, Telegram `/connect`) keep the stopped requirement.

### Operator defaults (traderton is the authority)

Add to traderton operator config, next to `agentRiskDefaults`: default test capital, default test provider, and whether generated-wallet test setup is allowed. Expose them through `get_operator_defaults`. herobids reads them over the boundary; the frontend `'1000'` is removed from the create path with WP-C and stays only as an edit-form prefill until it can read the same default. Config keys follow `docs/best-practices/configuration.md`; any env override gets an `.example` twin in the same change.

### Paper mode with a connection

Stop the silent paper/shadow flip: remove the carry-forward branch in `resolveExecutionModeForSkills` that changes `paper` to `shadow` when connections exist and back. Mode changes between the two test modes stay explicit (allowed by the existing test-to-test rule). The `test` alias is still mapped when a mode is first chosen. Update the functional tests that assert auto-transition (`agents.functional.test.ts`, `go-live.functional.test.ts`), the unit tests in `agent-config-helpers.test.ts`, and the glossary entry. Paper vs shadow trade-off: paper fills are simulated without a live market feed (cheaper, no per-agent feed), shadow fills against the live book (more realistic). Either needs no balance; this plan picks paper.

### Funding awareness

Go-live checks only for an active connection and plan entitlement; it never checks a balance. Funding is shown to humans today (the wallet address is `venueAccountRef` on the connection, and the setup response carries `fundingInstructionId`), but no agent tool exposes it. Add:
- A read tool for the agent (for example `get_funding_info`): wallet address, network, the funding instruction text and current balance for the agent's trading connection, resolved platform-side.
- Agent guidance in the trading skill: after `set_trading_setup`, say the wallet is unfunded and give the address and network; whenever the user asks to go live, repeat the funding status and address first, then point to the go-live confirmation.
- A soft warning in the go-live confirmation (UI and Telegram `/golive`) when the balance is zero. A warning, not a block, because funding can arrive right after.

### Going live

Unchanged for the agent: it never switches to live. Live is started by the user (go-live in the web app or `/golive` in Telegram), which creates a live copy with the agent's connection. `set_trading_setup` never touches mode.

### Provenance and visibility

Record on the profile change who set each value (`operator_default` or `user_stated`) in the journal, and the agent states the result to the user. The detail page already shows trading config; add the source if cheap.

## Revision 2026-10-14: defaults in Traderton (owner-approved direction; implementation awaiting approval)

Conditions set by the owner: the default values show in the user's edit form (capital in the main form, execution mode under Advanced Settings → Capabilities, both already shown) and the user can change them (own agent only; the existing rule that config changes need a stopped or crashed agent stays); no marking of defaults in the UI.

| # | Item | Gate |
|---|---|---|
| R1 | Traderton: when a profile row is first created and the action supplies no mode or no capital, fill mode from `execution.defaultOwnerMode` and capital from the operator default capital. Creation only, never on update or explicit clear. Decide the default on swap venues first (open question 1). Defaults must go through the same capability and ceiling checks as supplied values, and an idempotent replay of the same operation must not raise a manifest conflict (the stored manifest is compared with the replayed one). | Traderton tests: creation fills; update and clear never refill; replay of the same operation succeeds; swap-venue rule; checks still apply |
| R2 | Herobids: remove the `set_trading_setup` stack: worker tool and its test, tool index registration, `KNOWN_AGENT_TOOL_NAMES`, `TOOL_CATALOG` and base `requiredTools` entries, the broker message, payload and result schemas, capability-policy entry, broker handler, deps and `publishTradingSetupReply`, worker `tradingSetupDeps`; `setupTradingForAgent`, `loadTestDefaults` and their exports in `packages/db`; the test-provisioning part of the domain schema and the API operator-defaults loader; fix the comment in `agent-config-service.ts`. Lower the tool-visibility budget pinned in `runtime-tool-visibility.test.ts`. Check whether the grant `changes` option is still used and remove it if not. | `tsc` for db, domain, api, worker; tool catalog assertion; visibility test; full test run |
| R3 | `traderton-skills` crypto-trading: remove the ask-once, research-only and `set_trading_setup` lines; add the one-time disclosure of mode and capital and the stop-edit-start pointer; keep the connection, funding and go-live lines. First verify how the agent learns its mode (`get_account_summary` and `get_risk_limits` already give capital and limits). | Read-only check, then skill text review |
| R4 | Traderton: remove `defaultTestProvider` and `generatedWalletTestSetupAllowed` (proposed, not approved) | Traderton tests and a repo-wide search |
| R5 | Docs: amend D-B1 and D-B2 in IMPLEMENTATION, the stale WP-B sections, `PROGRESS.md` | Review |
| R6 | Rerun G1 on the new flow: blank agent, trading skill, `request_connection`, link, wake, paper trade with the disclosure, then edit capital while stopped and restart. Record each result in the G1 table. | G1 table updated with evidence |

Ordering and risks: Traderton R1 must exist before herobids R2 is used, otherwise a granted agent has a null profile and cannot trade; no deployment without approval. Traderton's working tree already holds unrelated uncommitted changes, so its commits stay separate. The live copy inherits the stored (default) capital and mode values like any explicit values, so the user should review them at go-live.

**Implementation status (2026-10-14, all uncommitted):**
- **R1 done (Traderton).** `set_agent_trading_profile` supplies `defaultTestMode` and `defaultTestCapital` when a profile row is first created without them, via `creationDefaults` applied in the repository insert branch only. The stored manifest keeps the action as supplied, so a replay compares equal. Swap venues fall back to shadow; capital is never defaulted for a live profile. Tests: domain and tool tests pass; the repository test for first-creation-only and replay is written but **not run** (needs Postgres, `DATABASE_URL` unset here). Full Traderton suite 170 files passed, 2,990 tests passed, 108 skipped.
- **R2 done (herobids).** The `set_trading_setup` stack is removed, including the unused explicit-changes option on the running-agent grant, the herobids test-provisioning schema and the loader merge. Full herobids suite 339 files passed, 6,585 tests passed; `tsc` clean for db, domain, api, worker, web. The tool-visibility count is now 29.
- **R3 done.** Skill text rewritten in `traderton-skills`. It points the agent to `get_account_summary` for the real mode. The agent's "Execution mode" context line was always `paper` (the runtime descriptor falls back to `'paper'`; no caller passes a real mode), so on 2026-10-14 the owner chose to remove that line (option B). Nothing else read it. The descriptor's `executionMode` field itself is left in place.
- **R4 done (Traderton).** `defaultTestProvider` and `generatedWalletTestSetupAllowed` removed from the schema, `config/default.yaml` and tests; no remaining references in the repo.
- **R5 in progress, R6 not started.**

## Work items

| # | Item | Gate |
|---|---|---|
| B1 | Traderton operator config for test defaults + `get_operator_defaults` extension; herobids boundary read | traderton and herobids tests; parity manifest unaffected or re-pinned per AGENTS.md |
| B2 | Running-agent grant path with descriptor refresh and wake | integration test: grant while running, agent sees the connection next call, no restart |
| B3 | Provisioning with `changes` (capital, risk, execution defaults) through the saga | profile has mode and capital after grant; saga compensation tested |
| B4 | Worker-to-API mechanism and `set_trading_setup` tool; register in `KNOWN_AGENT_TOOL_NAMES` and `TOOL_CATALOG` | tool catalog assertion; tool tests incl. ceiling violation |
| B5 | Reuse-or-create generated test connection; plan connection limit handling | free-plan test: limit error is returned to the agent in plain words |
| B6 | Trading skill instructions: the ask-once flow and no-trade-before-answer rule | agent eval run on the end-to-end UAT |
| B7 | Remove the silent paper/shadow carry-forward flip; update tests and glossary | tests assert paper stays paper with a connection; explicit paper-to-shadow still works |
| B8 | `get_funding_info` tool, trading-skill funding guidance, zero-balance warning at go-live | tool test; UAT: agent states funding status at setup and on every go-live request |
| B9 | Gate G1 UAT (epic): blank agent, "help me trade", defaults path and specifics path, paper trade, funding message, go-live cloned agent | recorded in the epic folder |

## Implementation log

- **2026-10-13 — B1 done.** Three operator test-provisioning defaults added to traderton as a new top-level `testProvisioningDefaults` block (`defaultTestCapital: "1000"`, `defaultTestProvider: "hyperliquid"`, `generatedWalletTestSetupAllowed: true`), exposed through `get_operator_defaults` (merged into the response) and consumed in herobids by widening `loadOperatorRiskDefaults` to parse both blocks into a combined `OperatorDefaults` type. Decisions: (1) new top-level key, not extending `agentRiskDefaults` (keeps the 17-field risk block risk-only and parity-stable); (2) widened the existing loader rather than a sibling (one boundary call, one cache; existing callers only read risk fields so no caller changes). Traderton domain build + trading-profiles tests (26/26) + lint green; herobids domain build + traderton-operator-defaults tests (7/7) + lint green. Outstanding (MEDIUM): `defaultTestProvider` is an unconstrained free string — constrain to a wallet-generation-capable venue enum before B3/B5 consume it. Outstanding (LOW): redundant `get_operator_defaults` test; `as never` casts in tests; capital string→number conversion boundary to confirm in B3.
- **2026-10-13 — B2 done.** Added `grantConnectionToRunningAgent` (dedicated running-agent grant path) alongside the unchanged stopped-only `grantConnection`. Threaded an `allowRunning` flag through `prepareConnectionChange`/`revalidateConnectionChange` (default false, so the stopped-only path is untouched); extracted the shared grant saga into `executeGrantSaga` so the two public functions differ only in the stopped check. The running path keeps ownership, activeness and in-transaction revalidation, and after a successful commit invokes an injected `opts.wake(agentId, { provider, connectionId })` callback (best-effort — a failed wake does not fail the grant). Also added the `connection` wake source to `AgentWakePayloadSchema` (`ConnectionWakeContextSchema`: `{ requestId, provider, connectionId?, reason: completed|declined|expired }`). Tests: domain wake-source (4 new) + service running-grant (5 new) pass; full API services suite 120/120; `pnpm lint` + domain build + `git diff --check` green. The wake callback is injected (constructor-injection style) — the real Redis XADD wiring lands in A5/B4.
- **2026-10-13 — B8 done.** `get_funding_info` lives in Traderton's provisioning tools (owner-scoped read beside `get_venue_account`) and returns the funding address, venue network label, latest balance snapshot and `fundingStatus`. Exposed to crypto-trading via `SKILL_TOOL_MAP`; herobids wrapper in the account tools. Decision: `unknown` until the trading actor records a snapshot, so no live venue call in this read. Deferred: the zero-balance go-live warning.

## Risks and open questions

1. **Plan limits (superseded 2026-10-14: the setup tool no longer creates connections; the limit now applies on the link page).** Checked: the free plan allows 5 active connections, 5 venue accounts and live mode (`config/default.yaml`, `plan-guards.ts`), so a generated test wallet is allowed unless the user already holds 5 active connections. Handle that edge case: the tool returns the limit error in plain words and the agent tells the user to remove one or upgrade. Reuse an existing generated connection first so most users never hit it.
2. **Actor rebuild on a profile change.** Checked in traderton. Edit-form and PATCH/PUT changes require a stopped or crashed agent, and stopping an agent calls `stop_agent_actor`, so those edits never rebuild a live actor. The only way to bump a profile revision under a live actor is the new running-agent grant (B2), and only when the agent already has an actor (for example it already traded on another connection); first-time provisioning has none, because the actor is created lazily on the first venue-resolving call. In that case concurrent decisions are serialized behind one rebuild (`agent-direct-actor-ensure.test.ts`, case 4), so they are not lost. A decision already executing on the old actor is not awaited by `stop()` (it clears timers and sets `running=false`); its fills still persist, but the new actor reads positions at start and could briefly miss a fill landing right after. Mitigation: B2 only allows the running-agent grant when the agent has no live trading actor or no open decision, or make `stop()` await the in-flight cycle (traderton follow-up).
3. **Paper pricing.** Verified, not a risk: decision prices come from a per-agent mark source, the agent's last fill for the instrument or else the worker-wide fallback (Hyperliquid public mids, then the CoinGecko oracle), with no credentials and the same in every mode (`composition/decision-intake.ts`, `create-trading-runtime.ts`). The paper executor fills at that price plus simulated slippage and fee. Only caveat: a symbol missing from both sources fails the decision, same as shadow.
4. **Unanswered question.** If the user never answers, the agent stays research-only. Decide the reminder cadence (suggest once per session, not per tick).
5. **Wallet sprawl.** One generated test connection per user, reused across agents; confirm that sharing a venue account between agents is allowed (profiles are keyed per agent and venue account, so it should be).
6. **Mirror drift.** Traderton config and `get_operator_defaults` changes need the herobids side re-pinned per AGENTS.md (parity-drift rules).

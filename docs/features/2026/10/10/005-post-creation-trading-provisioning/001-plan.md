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
- Neither path can enable live mode. Live stays with go-live and an explicit UI confirmation.
- The provisioned test setup is pinned to **paper** (fully simulated), on a generated wallet that is never funded for test purposes.
- The agent tells the user the wallet is unfunded and must be funded before live, at setup and again every time the user asks to go live.

## Design

### Agent-facing flow

1. The agent adds the trading skill. The trading skill's instructions tell it: before any trading action, ask once: "Want me to pick safe defaults (test mode with simulated money), or do you want to set capital and risk yourself?" Persist the answer in the agent's memory so it is not asked again. No trading action before it is answered; research and market reads are fine.
2. The agent calls `set_trading_setup`.

### Tool: `set_trading_setup`

- Params: `capital?`, `riskPosture?` (partial), `connectionId?`. Omitted values come from operator defaults. No `mode` param: the provisioned mode is always `paper`.
- Server-side steps, in one saga (reuses the profile reconciliation saga and, after WP-H, the shared derivation):
  1. Find a usable trading connection for the user (active, resolved venue account). If none, create a generated-wallet connection for the operator default test provider (hyperliquid). Reuse an existing generated one before creating another.
  2. Grant it to the agent (new running-agent path, see below).
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

Unchanged. The agent explains that live needs the user's own wallet or keys (WP-A `request_connection` link) and the go-live confirmation in the UI. `set_trading_setup` never touches mode.

### Provenance and visibility

Record on the profile change who set each value (`operator_default` or `user_stated`) in the journal, and the agent states the result to the user. The detail page already shows trading config; add the source if cheap.

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

## Risks and open questions

1. **Plan limits.** Checked: the free plan allows 5 active connections, 5 venue accounts and live mode (`config/default.yaml`, `plan-guards.ts`), so a generated test wallet is allowed unless the user already holds 5 active connections. Handle that edge case: the tool returns the limit error in plain words and the agent tells the user to remove one or upgrade. Reuse an existing generated connection first so most users never hit it.
2. **Actor rebuild on a profile change.** Checked in traderton. Edit-form and PATCH/PUT changes require a stopped or crashed agent, and stopping an agent calls `stop_agent_actor`, so those edits never rebuild a live actor. The only way to bump a profile revision under a live actor is the new running-agent grant (B2), and only when the agent already has an actor (for example it already traded on another connection); first-time provisioning has none, because the actor is created lazily on the first venue-resolving call. In that case concurrent decisions are serialized behind one rebuild (`agent-direct-actor-ensure.test.ts`, case 4), so they are not lost. A decision already executing on the old actor is not awaited by `stop()` (it clears timers and sets `running=false`); its fills still persist, but the new actor reads positions at start and could briefly miss a fill landing right after. Mitigation: B2 only allows the running-agent grant when the agent has no live trading actor or no open decision, or make `stop()` await the in-flight cycle (traderton follow-up).
3. **Paper pricing.** Verified, not a risk: decision prices come from a per-agent mark source, the agent's last fill for the instrument or else the worker-wide fallback (Hyperliquid public mids, then the CoinGecko oracle), with no credentials and the same in every mode (`composition/decision-intake.ts`, `create-trading-runtime.ts`). The paper executor fills at that price plus simulated slippage and fee. Only caveat: a symbol missing from both sources fails the decision, same as shadow.
4. **Unanswered question.** If the user never answers, the agent stays research-only. Decide the reminder cadence (suggest once per session, not per tick).
5. **Wallet sprawl.** One generated test connection per user, reused across agents; confirm that sharing a venue account between agents is allowed (profiles are keyed per agent and venue account, so it should be).
6. **Mirror drift.** Traderton config and `get_operator_defaults` changes need the herobids side re-pinned per AGENTS.md (parity-drift rules).

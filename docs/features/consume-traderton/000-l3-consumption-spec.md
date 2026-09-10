# L3 — herobids consumes Traderton over REST (consumption spec)

**Status:** APPROVED spec (decisions D1–D5 locked 2026-09-08). Work happens on THIS branch
(`consume-traderton`) only. Slice-by-slice; pause for human review between slices.
**Branch:** `consume-traderton` (off `main` @ v0.3.0). **herobids `main` and all other branches are
untouchable.** Merging this branch to `main` = **cutover**, and requires explicit human approval.

## Where the authority lives (read this)

This is the herobids-side **working spec**. The **invariants, the law, and the settled cross-repo
decisions live in Traderton** and are the source of truth **until cutover**:

- **[../../../../traderton/docs/CANONICAL-STATE.md](../../../../traderton/docs/CANONICAL-STATE.md)** — the
  single source of truth for state/decisions/invariants (see its §3.1 for the L3 decisions, §5/§5.1 for the
  read-only exception + the repo-of-record transition).
- **[../../../../traderton/docs/005-consumer-boundary-contract.md](../../../../traderton/docs/005-consumer-boundary-contract.md)**
  — the REST/HMAC contract herobids calls (endpoints, envelope, canonical string, failure codes,
  idempotency, health).
- The full investigation + proposal (the seam map this spec is built on) is
  `traderton/docs/features/L3-01-herobids-consumption-proposal.md`.

**Repo-of-record note:** herobids becomes the *working root* at cutover (a working-location change only —
Traderton is NOT absorbed; it stays a separately-deployed boundary/library service). Until then, the
canonical docs stay in Traderton; this spec points back to them.

## 1. What L3 is

herobids stops running trading **in-process** and instead makes **signed HTTPS calls to the Traderton
boundary** (`POST /internal/v1/tools:invoke`, `GET /internal/v1/invocations/:requestId`, HMAC per 005).
herobids KEEPS the platform it always owned — users, the connections/agents grant layer, the agent
message-broker + messaging, LLM/reasoning, human approvals, the per-agent `maxBots` decision — and injects
the platform-owned VALUES into the 005 envelope (authenticated `ownerId`+`actor`, resolved `venueAccountId`,
grant validity, `maxBots`). Everything trading (risk gate, planner, executors, venues, market-data,
mechanical strategy, the actor/runtime execution loop, the trading DB) is DELETED from herobids and lives
only behind the boundary (a separately-deployed Traderton service).

**Why REST, not in-process (legal):** consuming in-process would put `@traderton/*` back inside the herobids
deployable, re-coupling trading to the platform's payment rails — the exact risk the split exists to
prevent. Cutover is over REST; there is no in-process cutover.

## 2. How herobids drives trading TODAY (the seam — verified read-only)

Two dispatch shapes (both must be rewired, or an in-process trading path survives cutover):

- **Redis-brokered side-effecting.** A tool calls `ctx.publishToInbound(AGENT_MESSAGE_TYPES.*, …)`;
  `AgentMessageBroker.processInbound` (`apps/worker/src/agents/agent-message-broker.ts`) validates +
  capability-gates + resolves grants, then routes to a handler that drives the engine:
  - `submit_decision` (`apps/worker/src/tools/trading.ts`) publishes `DECISION_SUBMIT`, then **blocks on
    `ctx.redis.blpop('agent:decision:reply:${decisionId}', 30)`** for a rich reply
    (`accepted | pending_approval | rejected | error`). Broker → `AgentDecisionHandler.handleDecisionSubmit`
    (`apps/worker/src/agents/agent-decision-handler.ts`) calls `submitDecisionForExecution` from
    `@herobids/engine` — **the trading execution core**.
  - `create_bot`/`start_bot` (`apps/worker/src/tools/bots.ts`) publish `MANAGE_BOT`; broker →
    `handleManageBot` (`agent-message-broker.ts` ~:560–850) resolves the connection/venue-account
    (`getRuntimeCapabilityDescriptor`:568, `getResolvedVenueAccount`:595, `isConnectionOwnedBy`:601),
    enforces `botLimitCheck` (maxBots, :607), stamps `venueType` (:612–618), enqueues the trading actor via
    `botStart` (:748/:825) → BullMQ `trading-instance-lifecycle` → `WorkerRuntime` (`runtime.ts`) →
    `AgentTradingActor` (the execution loop).
- **Direct-DB reads + light bot management.** `get_account_summary`, `get_analytics`, `list_positions`,
  `list_bots`, `get_bot_status`, `stop_bot`, `adjust_bot_config` reach trading Postgres directly via
  `ctx.botRepo` / `ctx.riskContractOps` / `ctx.executionConfig` (`apps/worker/src/tools/{account,analytics,bots}.ts`).
- **Second bot path (non-agent):** `apps/api/src/routes/bots.ts` `POST /bots` enqueues the SAME
  `trading-instance-lifecycle` queue directly.

The mixed `ToolContext` (`packages/domain/src/tools.ts`, `extends TradingToolContext`) carries both platform
(`agentId`, `agentRepo`, `publishToInbound`, `redis`) and trading (`botRepo`, `riskContractOps`,
`executionConfig`) fields — the type itself is a seam.

## 3. DELETE / KEEP / REWIRE inventory

**DELETE (moves fully behind REST):** packages `engine`, `venues`, `market-data`, `strategy`,
`backtesting`; worker execution slices (`agent-trading-actor.ts`, `trading-actor.ts`, `execution-actor.ts`,
`runtime.ts`, technical/scanner/tick/candle/swap/venue-adapter-factory helpers); trading DB tables
(`positions`, `fills`, `orders`, `execution-plans`, `decisions`, `decision-*`, `balance-snapshots`,
`reconciliation-events`, `backtest-runs`, `instruments`, `bots`) + repos. **`venue_accounts` is special —
D2 below.**

**KEEP (platform):** `users`, `connections`, `agent-connections`, `agents`, `user-credentials`,
`agent-runtime-sessions`, `agent-messages` tables + repos; the grant/venue-account resolution front-end
(`startup-context.ts` `resolveBotStartupContext`, `agent-runtime-descriptor.ts`
`getRuntimeCapabilityDescriptor`, `repositories.ts` `getResolvedVenueAccount`/`isConnectionOwnedBy`,
`connections.resolvedVenueAccountId`); the message-broker + messaging; LLM; human approvals; the per-agent
`maxBots` decision (`agent-create-normalization.ts`).

**REWIRE (surgical — ~5–6 files, the fusion points):**
1. `agent-message-broker.ts` `handleManageBot` — keep the grant-resolve + maxBots + venue-stamp PRE-work
   (produces the injected values); replace the `botStart`→actor kickoff with a signed REST `tools:invoke`.
2. `agent-decision-handler.ts` `handleDecisionSubmit` — keep the approval-required gate (source
   `venueAccountId` from the grant front-end, D2/D-c); replace `submitDecisionForExecution` with a signed
   REST `tools:invoke` of `submit_decision`.
3. `apps/worker/src/index.ts` composition root — swap the trading half (WorkerRuntime/actor/botStart) for a
   constructed Traderton REST client; delete the trading-package imports.
4. `apps/api/src/routes/bots.ts` — `POST /bots` enqueue → signed REST invoke.
5. `packages/domain/src/tools.ts` `ToolContext` — drop the trading fields; read tools call the boundary too.
6. Read tools (`tools/{account,analytics,bots}.ts`) — direct-DB reads → signed REST invokes of the
   read-only tools.

## 4. The Traderton REST client (authored in herobids — a thin adapter, no trading behaviour)

A small `fetch`-based client (e.g. `apps/worker/src/traderton/client.ts` + a shared HMAC signer), following
herobids' existing HMAC patterns (`connections-oauth-state.ts` ~:47–52, `auth.ts` ~:59–73 — `createHmac`
+ `timingSafeEqual`; no shared util exists — factor one). It builds the 005 envelope, signs the canonical
string (`METHOD\nPATH\nX-Traderton-Timestamp\nSHA256(body)` — **mirror Traderton's committed dev signer
`traderton/packages/boundary/src/dev/sign.ts`** so bytes match the verifier), POSTs `tools:invoke`, maps the
`TradertonToolResultV1` outcome back to the tool reply, and polls `GET invocations/:requestId` for the
async/idempotent case. Config: add a `boundary` block (`baseUrl`, `hmacSecretRef`, `consumerId`, `keyId`,
`timeouts`) to `config/*.yaml` + `packages/domain/src/config/schema.ts` (env override for the secret, per
the `STRIPE_WEBHOOK_SECRET` convention). **Invariant:** the client injects VALUES + calls copied tools; it
authors no risk/planner/executor logic.

## 5. Acceptance bar + verification

- **herobids' own trading tests stay green** — the worker trading tests (tool tests, broker/handler tests,
  drive-path integration tests) are re-pointed at the boundary (or converted to boundary-differential
  tests). The "not weaker than herobids-today" parity bar.
- **REST differential at the boundary** — drive representative flows (a paper `submit_decision`, a
  `create_bot`, the read tools) through BOTH herobids-today (in-process) and herobids-on-this-branch
  (REST→Traderton) with identical inputs; assert identical trading outcomes. (This is the L3 differential
  the Traderton roadmap defers to the REST boundary, since L2 was skipped.)
- **The stack:** Traderton's `docker-compose.yml` stands up the boundary + Postgres + Redis; herobids points
  its `boundary.baseUrl` at it for local/staging runs.
- **Merge gate (human-owned):** herobids consumes the library (this branch) + all tests pass + run locally
  AND on staging for a while (manual/visual/black-box) + explicit human approval → merge = cutover.

## 6. Locked decisions (D1–D5)

- **D1** — work on `consume-traderton`; `main`/other branches untouchable; merge = cutover (human-approved).
- **D2 — `venue_accounts` ownership:** **Traderton owns `venue_accounts` + `user_credentials`** (it makes
  the venue calls). herobids injects the `venueAccountId` it resolves from the **connection grant it already
  owns** (`connections.resolvedVenueAccountId`) — a platform VALUE it holds without storing the account row.
- **D3 — `submit_decision` async mapping:** invoke → poll `GET invocations/:requestId` to the deadline,
  preserving all reply statuses. `pending_approval` stays a **herobids** outcome produced by the platform
  approval gate *before* the boundary call (the boundary only executes an already-approved decision).
  *Polling's shortcoming + the push/webhook alternative are backlog B10 in Traderton's
  [010-improvement-backlog](../../../../traderton/docs/010-improvement-backlog.md).*
- **D4 — sub-phasing (§7).**
- **D5 — docs:** this working spec + the per-slice prompts live here (herobids); the canonical/invariant
  docs stay in Traderton until cutover; repo-of-record migrates at cutover (CANONICAL-STATE §5.1).

## 7. Sub-phasing (slice-by-slice on this branch; reviewed; paused between)

- **L3a — the Traderton REST client + config + signer** (no rewire; nothing deleted). Unit-tested against a
  stubbed boundary. *(Implementer prompt: `001-l3a-implementer-prompt.md` in this dir.)*
- **L3b — rewire the READ path** (lowest risk): `get_account_summary`/`get_analytics`/`list_positions`/
  `list_bots`/`get_bot_status` → REST; drop the trading fields they used from `ToolContext`.
- **L3c — rewire the SIDE-EFFECTING path:** `submit_decision` (D3), `create_bot`/`start_bot`/`stop_bot`/
  `adjust_bot_config` in BOTH call sites (broker + API route); keep grant/maxBots/approval PRE-work.
- **L3d — delete the trading packages + worker execution loop + trading DB** (the big subtraction), once
  nothing imports them; run the differential + herobids' suite.
- **L3e — differential + staging soak → the merge gate.** Human-owned.

## 8. Subtleties (tracked; see D2/D3 + the proposal)

- **`venue_accounts` straddles the boundary** — resolved by D2 (Traderton owns it; herobids injects the
  grant-resolved id).
- **`submit_decision` sync 30s BLPOP → async invoke+poll** — D3.
- **Approval-required (platform) currently reads the trading intake's `venueAccountId`** — after the engine
  leaves, source it from the grant front-end (kept), not the boundary. Confirm during L3c.
- **Dual bot-drive call sites** (broker + `api/routes/bots.ts`) — BOTH must be rewired (L3c); missing either
  leaves a live in-process trading path. Checklist item, not a decision.

# Step 9 — External Backend Genericization Discovery

**Status:** complete (discovery; read-only — no code changed).
**Date:** 2026-10-02.
**Program:** [ENTRYPOINT](./000-program/ENTRYPOINT.md) · [PROGRESS](./000-program/PROGRESS.md) · [roadmap](./001-staging-first-external-backend-roadmap.md) · [DECISIONS](./000-program/DECISIONS.md)
**Governing ADR:** [ADR 015](../../../tech/architecture/adrs/2026/09/015-external-backend-skill-registration.md)

## Purpose & scope

Satisfy ADR-015's six **Discovery Exit Criteria** so the Step 10 implementation
plan may be drafted. This is **read-only analysis**: a symbol-level disposition
for `packages/domain/src/{traderton,trading}/`, an importer inventory, the
concrete trust model, an end-to-end trace, the MCP comparison, and the
legal/product questions engineering cannot settle. No code is changed here;
Steps 10–16 do the work.

**Non-goals:** no implementation, no infra mutation, no boundary behavior change.
Settled decisions D1–D10 are not relitigated.

**Evidence base:** a full read-only sweep of the herobids repo (file:line
citations throughout). Where a fact could not be determined from code it is
listed under Criterion 6 or flagged "open".

---

## Criterion 1 — Symbol-level disposition

Disposition vocabulary: **GENERICIZE-KEEP** (generic concern; stays in herobids,
renamed off the `Traderton` prefix), **GENERIC-KEEP** (already generic; keep as
is), **MOVE** (trading-domain → Traderton), **SPLIT** (part generic / part
trading), **DELETE** (dead/unused), **DEFER** (product/legal-gated).

### `packages/domain/src/traderton/` → GENERICIZE-KEEP (becomes `ExternalBackendClient`)

The whole directory is transport/trust/envelope with `unknown` payloads — no
trading/venue/order/market semantics (headers: `contract.ts:1-11`,
`client.ts:1-9`, `sign.ts:1-18`). Per ADR-015 §2/§6 and D7 it is the body of the
future generic client. It is a **subpath export** (`@herobids/domain/traderton`,
`packages/domain/package.json:30-33`), deliberately NOT in the web barrel
(`src/index.ts:52-57`, pulls `node:crypto`+`fetch`).

| Symbol | File | Disposition | Target name / note |
|---|---|---|---|
| `TradertonClientConfig` | client.ts | GENERICIZE-KEEP | `ExternalBackendClientConfig` |
| `InvokeToolInput` | client.ts | GENERICIZE-KEEP | generic toolName + `unknown` payload |
| `TradertonClientResult` | client.ts | GENERICIZE-KEEP | generic success/failure/in_progress/transport_error |
| `PollOptions` | client.ts | GENERICIZE-KEEP | generic |
| `TradertonClient` (class) | client.ts | GENERICIZE-KEEP | `ExternalBackendClient` |
| `createTradertonClient()` | client.ts | GENERICIZE-KEEP | `createExternalBackendClient()` |
| `TradertonActorType` | contract.ts | GENERICIZE-KEEP | platform actor model (agent/bot/user/system) |
| `TradertonCaller` | contract.ts | GENERICIZE-KEEP | consumerId+keyId trust identity |
| `TradertonSubject` | contract.ts | GENERICIZE-KEEP | ownerId + actor |
| `TradertonToolInvocationV1` | contract.ts | GENERICIZE-KEEP | the 005 envelope; `'1.0'` → contract-version concern (Crit 3) |
| `TradertonBoundaryFailureCode` | contract.ts | GENERICIZE-KEEP | transport/trust codes, not trading |
| `TradertonSuccess/Failure/Outcome` | contract.ts | GENERICIZE-KEEP | generic terminal outcomes |
| `TradertonToolResultV1` | contract.ts | GENERICIZE-KEEP | generic |
| `TradertonToolInvocationStatusV1` | contract.ts | GENERICIZE-KEEP | generic |
| `TRADERTON_INVOKE_PATH`, `TRADERTON_STATUS_PATH_PREFIX`, `tradertonStatusPath()` | contract.ts | GENERICIZE-KEEP | rename; path-ownership question in Crit 3/6 |
| `SigningIdentity`, `SignRequestInput`, `SignedHeaders` | sign.ts | GENERICIZE-KEEP | generic HMAC material |
| `buildCanonicalString/signRequest/signInvoke/signStatus` | sign.ts | GENERICIZE-KEEP | **must preserve exact wire bytes** (mirrors backend verifier, `sign.ts:9-13`) |
| `index.ts` barrel | index.ts | GENERICIZE-KEEP | keep as renamed subpath barrel |

### `packages/domain/src/trading/`

| Symbol(s) | File | Disposition | Reasoning |
|---|---|---|---|
| `ActorHealthSnapshot` | actor-health.ts | **SPLIT → lean GENERIC-KEEP** | Generic health envelope (status/reasons/updatedAt/streamState/reconciliationState) stays; trading fields (`executionMode`, `lastVenueSuccessAt/ErrorAt`, `pendingLiveWorkCount`) genericized/dropped. |
| `actorHealthKey()`, `ACTOR_HEALTH_TTL_SECONDS` | actor-health.ts | GENERIC-KEEP | Redis key/TTL, generic. |
| `ExecutionCapabilityInput/ErrorCode/Error`, `venueTypeFromProvider()`, `validateExecutionCapability()` | execution-capability.ts | **MOVE** | executionMode×venueType compatibility, provider→venue taxonomy — pure trading write-time validation. |
| `MODE_RANK`, `checkModeEscalation()` | mode-rank.ts | **MOVE** | paper/shadow/live escalation = trading risk policy. |
| `ToolCategory` | tool-contract.ts | **SPLIT** | Generic read/write/execute operation model stays; `read-trade`/`execute-trade`/`read-market-data` targets become backend-descriptor capability tags (ADR-015 §7). |
| `ToolResult`, `AgentTool<Ctx>`, `ToolDefinition`, `isReadOnlyCategory/getCategoryOperation/getCategoryTarget` | tool-contract.ts | GENERIC-KEEP | Generic tool interface + category parsing. |
| `ToolBotRecord`, `ToolPositionRecord`, `ToolAnalyticsResult`, `TradingAgentTool` | tool-contract.ts | **MOVE** | Bot/position/PnL record shapes — trading domain. |
| `TradertonReadResult` | tool-contract.ts | GENERICIZE-KEEP | domain-clean mirror of client read union; rename. |
| `TradingToolContext` | tool-contract.ts | **SPLIT (mostly MOVE)** | Generic ports (`redis`, `publishToInbound`, boundary port [rename], `db`, `sessionMetrics`) stay as the generic agent tool-context; trading ports (`executionMode`, `authorizationMode`, `marketDataRegistry`, `priceService`, `riskContractOps`, `instrumentRepo`, `agentRepo`, `operatorDefaults`, `selectedVenueAccountResolver`) move with their tools. **Heaviest conceptual split.** |
| `AgentWakePayloadSchema/AgentWakePayload` | trading-protocol.ts | **SPLIT (central)** | Base envelope (wakeId/reason/eventIds/priority/requestedAt/notBefore) is the generic wake ADR-015 says MAY stay; the 5 trading `context` variants move to backend-supplied context. |
| `WakePrioritySchema/WakePriority` | trading-protocol.ts | GENERIC-KEEP | low/normal/high scheduling priority. |
| `ReminderWakeContext*` | trading-protocol.ts | **SPLIT → borderline GENERIC** | Reminder/message is a generic wake; only `scheduledBy:'scout'|'judge'` ties to trading roles — see Crit 6 Q3. |
| `WatchPurpose*`, `ContextSnapshotPayload*`, `WatchThresholdWakeContext*`, `DiscoveryDeltaWakeContext*`, `RegimeChangeWakeContext*`, `ScannerWakeContext*`, `TRADING_SESSION_NAMES/TradingSessionName/Schema` | trading-protocol.ts | **MOVE** | watch/snapshot/discovery/regime/assessment/trading-session — ADR-015 names each as Traderton's. |
| `TimeInForce`, `VenueCapabilities`, `VenueCapabilityErrorCode/Error`, `validateTimeInForce/AmendInPlace/CancelAndReplace/PostOnly/ReduceOnly/OrderAttributes`, `OrderAttributeFlags` | venue-capability.ts | **MOVE (whole file)** | Order/venue semantics; ADR-015 §Initial Disposition + the ownership audit mark it **dormant in herobids**. |

---

## Criterion 2 — Importer inventory

### 2A. `@herobids/domain/traderton` — the critical mass (~32 prod + ~22 test files)

Decisive finding: **the coupling is almost entirely type-level, not
implementation.** Only **4 files construct the client** (`createTradertonClient`):
`apps/api/src/index.ts`, `apps/api/src/routes/exports.ts`, `apps/worker/src/index.ts`
(4 instances), `apps/worker/src/agent.ts` (per-agent). Everything else consumes
an **injected** `TradertonClient` / `TradertonClientResult` / `TradertonSubject`
**type** or calls `.invoke()` through a port. **Signing has ZERO importers
outside the dir** (fully encapsulated). → Genericizing the type names rewires
most importers mechanically.

| Cluster | Action on genericize |
|---|---|
| api composition root (`index.ts`) | GENERICIZE — build `ExternalBackendClient` from the registration/config |
| api routes (`routes/*.ts`, ~17 files) | GENERICIZE (generic client type + injected subject). `exports-traderton.ts` is a dedicated trading export route → rename or DELETE/DEFER |
| api services/agents (`trading-profile-reconciliation-saga.ts`, `provider-links.ts`, `plan-guards.ts`, `traderton-operator-defaults.ts`, blueprint/lifecycle services) | GENERICIZE; the reconciliation saga + operator-defaults are trading-specific → MOVE/DEFER |
| worker composition roots (`index.ts` ×4, `agent.ts` per-agent) | GENERICIZE — preserve the multiple-consumer instantiation pattern |
| worker adapters (`traderton/{read,write,hybrid-price}-adapter.ts`) | GENERICIZE — rename to external-backend adapters |
| worker agents/tools (`agent-message-broker`, `decision-boundary-mapping`, `agent-evaluation/*`, `tools/traderton-read.ts`) | GENERICIZE result mapping |

### 2B. trading-module importers (barrel-exported via `@herobids/domain`)

| Module | Prod importers (non-test, non-dist) | Action |
|---|---|---|
| `venue-capability.ts` | **ONLY** `packages/domain/src/ports/venue.ts` (type-only) + barrel | Confirms dormant → **MOVE**; the one importer (a trading port) follows. |
| `execution-capability.ts` | api: `agent-create-normalization.ts`, `index.ts`, `routes/{agents,blueprints,bots,capabilities/trading}.ts`, `services/blueprint-execution-capability-adapter.ts`; worker: `agents/agent-message-broker.ts`; domain ports | **MOVE** the validator; importers are trading write-time validation → GENERICIZE (if a generic config-validation hook remains) else MOVE/DELETE. Heaviest trading-module coupling. |
| `mode-rank.ts` | `apps/worker/src/tools/bots.ts`, `tool-contract.ts`, barrel | **MOVE**; `bots.ts` (bot lifecycle tool) moves with it. |
| `tool-contract.ts` | ~22 files: all `apps/worker/src/tools/*`, worker adapters, market-intelligence, api `routes/{bots,connections,exports-traderton}.ts`, `apps/web/src/lib/api-client.ts`, `packages/domain/src/tools.ts` | **SPLIT**: generic `AgentTool`/`ToolResult`/`ToolDefinition` stay; trading tools + ctx fields MOVE. `tools.ts` (`ToolContext extends TradingToolContext`) rebased on generic context. |
| `actor-health.ts` | api `index.ts`+`routes/actor-health.ts`, worker `actor-health-publisher.ts`+`agent-ephemeral-redis-cleanup.ts`, domain `infra/server-health.ts` | GENERIC-KEEP (health plumbing); genericize trading fields. |
| `trading-protocol.ts` | web `style-mapping.ts`; worker `agent.ts`, `agents/{agent-reconnect-handler,instance-event-publisher}`, `assessment-review-message`, `hybrid-agent-evaluator`, `market-intelligence/{assessment-review-runner,monitor}`, `position-coverage`, `runtime-composition`, `tick-gates`; domain `agent-protocol.ts`, `config/{index,schema}.ts` | **SPLIT** follows symbol split. **Complication:** symbols reach consumers *through* `agent-protocol.ts` + `config/schema.ts` re-exports (`WakePriority` comment at `trading-protocol.ts:150-152`); moving trading schemas requires untangling that indirection first. |

---

## Criterion 3 — External Backend Definition, descriptor trust, rotation, revocation, failure

Synthesized from ADR-015 §3/§4 + the existing HMAC implementation (`sign.ts`,
`contract.ts`) + the current `BoundaryConfig` (see Config wiring). The current
system has **transport trust (HMAC) but no descriptor-trust layer** — that layer
is what Step 10 designs. Target model:

### `ExternalBackendDefinition` (operator registration record)
Generic transport + trust metadata ONLY (ADR-015 §3 — no domain instructions/
tool-semantics/pricing/venue/risk):
- `backendId` — stable backend identity (replaces hard-coded `consumerId:'herobids'` pairing with a named backend).
- `endpoint` — base URL + **contract version** (today `/internal/v1/...` + envelope `'1.0'`).
- `callerCredentialRef` — reference to the HMAC signing identity (keyId + secret ref); secrets stay in secret storage, not the record.
- `trustedDescriptorSigningKeys[]` — public keys the backend's descriptor is verified against.
- `healthPolicy` — health endpoint + gating thresholds (reuses `/health/ready`).
- `approvedSourceSkillRefs[]` — the skills.sh source refs this backend may deep-integrate (ADR-015 §4/§5).
- `descriptorPinning` — pin/cache policy (pinned digest or max-age).

### External Backend Descriptor (published by the backend, verified by herobids)
Signed, versioned (ADR-015 §4). Binds `approvedSourceSkillRefs` → backend-owned
instructions, tool descriptions, tool schemas, generic availability metadata.
Herobids **verifies** against the registration, **pins/caches** per policy, and
**rejects** expired / untrusted / mismatched / revoked descriptors.

### Trust mechanics
- **Signing (reuse):** the existing HMAC-SHA256 canonicalization (`buildCanonicalString` = `METHOD\nPATH\nX-Timestamp\nSHA256(body)`) secures *invocation* transport and must be preserved byte-for-byte. The descriptor adds a **second, asymmetric** trust artifact (descriptor signature verified against `trustedDescriptorSigningKeys`) — distinct from the per-request HMAC. Step 10 decides the descriptor signature scheme (recommend asymmetric/ed25519 so the backend holds the private key and herobids only stores public keys).
- **Key rotation:** `trustedDescriptorSigningKeys[]` is a *set* → overlap-window rotation (publish new descriptor signed by new key while old key still trusted; operator removes old key after cutover). HMAC caller key rotation uses the existing `keyId` indirection (`TradertonCaller.keyId`) — add a new keyId, re-sign, retire old.
- **Revocation:** operator removes a signing key / source-skill ref / disables the definition → herobids rejects the now-untrusted descriptor and strips the backend's tools from visibility (fail-closed).
- **Failure behavior (reuse existing, confirmed in Crit 4e):** content-level failures (validation/not_found/precondition) are non-faulting; transport/in_progress/deadline failures are retryable and fault the circuit breaker; writes fail **closed** (no in-process fallback). Descriptor-trust failures (expired/untrusted/mismatched/revoked) → the skill degrades to an ordinary instruction-only skill (no tools), never a hard crash.

### Open sub-questions (→ Step 10 / Crit 6)
- Contract version + invocation paths: fixed private contract vs descriptor-supplied per backend (Crit 6 Q1).
- Descriptor signature scheme (symmetric vs asymmetric) — recommend asymmetric; confirm in Step 10.

---

## Criterion 4 — End-to-end trace (external skill → executable)

**(a) Install.** Catalog/browse: `apps/api/src/routes/skills.ts` (external via
injected `ExternalSkillProvider`, `sourceKind:'external'` ~line 600;
`mapExternalToSkillView` ~line 515 hardcodes `requiredTools:[]`,
`capabilityFamilies:[]`, `instructions:''` — external skills get **no tools**
today). Real "install" = assignment: `agentSkills` INSERT at
`apps/api/src/services/agent-instantiation-service.ts:131` (+ PATCH on
`routes/agents.ts`). The agent's `skillIds` drive the worker.

**(b) Descriptor/backend resolution — TODAY none; hard-coded trading `if`s** (the
genericization targets ADR-015 §5 forbids):
- `packages/domain/src/skills.ts`: `TRADING_SKILL`/`BOT_MANAGEMENT_SKILL`/`RISK_MONITORING_SKILL` statically list trading `requiredTools` + `capabilityFamilies:['trading']` + `requiredContextBlocks:['tradingContext']` (~104-215); `SKILL_PRESET_MAP` (:471); `SYSTEM_SKILLS`/`SYSTEM_SKILL_SLUGS` (:479-500) seed `system/trading`; `TOOL_OWNER_OVERRIDES` (:511) + `buildToolOwnershipMap()` hard-assign trading tools to owner `'trading'`.
- `apps/api/src/routes/skills.ts`: `TRADING_ACCOUNT_TOOLS` (:66) + `buildTradingCapabilityValidationError` (~90).
- `packages/domain/src/provider-catalog.ts`: venue→`['trading']` (:70-93).
- `packages/db/src/agent-runtime-descriptor.ts`: `family==='trading'` readiness branches (:46/82/153-177).
- worker: `agent.ts:473` `isTradingSkill = id===...`; `runtime-composition.ts:700` + `agent-capabilities.ts:18` `.includes('trading')`.

**(c) Tool visibility (worker).** `agent.ts:407` reads `resolvedSkills`→`skillIds`;
`resolveSkills()` maps via static `ALL_SKILLS_BY_ID` (:452-468) + always-prepended
`BASE_SKILL`. `createToolRegistry()` (`tools/index.ts:89`) registers ALL tools
up-front; per-tick offered set = `allowedTools()` (`agent.ts:718`) =
`getVisibleToolNames()` (`runtime-composition.ts:2329`) from resolved skills'
`requiredTools` + capability grants; LLM list = `toolRegistry.getDefinitions([...allowedTools()])`
(`agent.ts:3716/3779`); each call gated `if (!allowedTools().has(call.tool))` (:1749).
→ Target: visibility driven by the **verified descriptor's** tool list, not static seeds + trading `if`s.

**(d) Invocation.** Read path: tool → `ctx.tradertonBoundary.invoke({toolName,payload})`
→ `read-adapter.ts` → `TradertonClient.invoke()` (`client.ts`): `buildEnvelope`→`signInvoke`→
`POST ${baseUrl}/internal/v1/tools:invoke`→`parseInvokeResponse`→`TradertonReadResult`.
Write path: `ctx.tradertonWriteBoundary.invokeAndAwait(...)` → `write-adapter.ts` →
`client.invoke()` then if `in_progress` `client.poll(requestId)` (signed
`GET /internal/v1/invocations/:requestId` via `signStatus` until terminal/deadline).
`submit_decision`: `decision-boundary-mapping.ts:buildSubmitDecisionPayload()`
injects subject (ownerId+actor) + resolved `venueAccountId`, calls side-effect boundary.

**(e) Result mapping.** Reads: `tools/traderton-read.ts:mapReadResultToToolResult()`
(success→data; failure→errorCode+retryable+fault, content-level codes non-faulting;
in_progress/transport_error→retryable). Writes: `mapWriteResultToToolResult()`
(in_progress→`precondition.not_ready`, fail-closed). submit_decision:
`mapBoundaryResultToDecisionOutcome()` (success→accepted+planId; failure→rejected;
in_progress/transport_error→error, never silent engine fallback). Underlying
`TradertonOutcome→TradertonClientResult` = `client.ts:mapTerminalResult()`.

### Config wiring (Step 11 input)
Single source `appConfig.boundary` (`BoundaryConfigSchema`,
`config/schema.ts:1572`; YAML `config/default.yaml:381-388`; env
`TRADERTON_BOUNDARY_{URL,HMAC_SECRET,CONSUMER_ID,KEY_ID,TIMEOUT_MS}` via
`apps/api/src/config.ts:71-75`). Startup validation is lenient (:1771). Built at
`apps/api/src/index.ts:197-202` (gated on `baseUrl && hmacSecret`) + 4 worker
instances + per-agent in `agent.ts:910-938`. **Step-11 implication:** move from a
single Traderton-named `boundary` block to an operator **registry of
`ExternalBackendDefinition`s**; the 5 instantiation sites become registry lookups.

---

## Criterion 5 — MCP comparison (stays DEFERRED; D4 reaffirmed)

Evidence: `docs/features/pending/000-capability-foundations/016-mcp-registration-layer.md`
(draft) + ADR-015 §8. Conclusion: **MCP remains deferred; no revised decision.**

- MCP is a **registration/transport/packaging layer**, not a backend or
  capability (016 Purpose + Fixed Decision 1). It does not provide the
  authenticated private invocation, descriptor trust, idempotency, health, and
  authorization path the first backend needs (ADR-015 §8).
- 016 Fixed Decision + "Relationship to the boundary": for platform-managed
  backends, MCP is an **optional packaging layer over the same boundary
  contract** — the execution still crosses the generic boundary. So MCP does not
  compete with or replace the External Backend contract this program builds; it
  can wrap it later.
- 016 is explicitly gated **after** the boundary is proven with ≥1 backend
  (016 Dependencies 1) and "Do not require MCP as a prerequisite for external
  backend integration" (Non-Goal 5).
- Net: building the generic External Backend contract first is the correct
  order; MCP layers on later without rework. No evidence supports pulling MCP
  forward. **D4 holds.**

---

## Criterion 6 — Legal/product questions engineering cannot settle

Routed to the operator / legal / payment-provider review (not Contemplator — these
are outside engineering's authority per ENTRYPOINT §1):

1. **Retained trading orchestration surfaces.** Which herobids-side trading-
   adjacent surfaces may remain (even generic) vs must be removed/moved:
   `exports-traderton.ts` route, `trading-profile-reconciliation-saga.ts`,
   `traderton-operator-defaults.ts`, billing links for trading, setup/connection
   flows. (DECISIONS open item; ADR-015 Consequences.)
2. **Contract-version & invocation-path ownership.** Do `/internal/v1/tools:invoke`
   + status paths and the `'1.0'` envelope version stay a fixed herobids-owned
   private contract, or become descriptor-supplied per backend? (Affects §3; has
   a product/boundary-ownership dimension — confirm against traderton
   `005-consumer-boundary-contract.md`.)
3. **Generic-role naming.** Are `scout`/`judge` (in `ReminderWakeContext.scheduledBy`)
   generic agent-runtime roles or trading-only? Determines whether reminder-wake
   stays generic (engineering can decide if confirmed generic — else it is a
   product-naming call).
4. **Canonical Traderton skills.sh publisher/repo ref** for `approvedSourceSkillRefs`
   (needed at Step 13; DECISIONS open item).
5. **`system/trading` seed removal confirmation.** ADR says no migration window
   (greenfield). Confirm no non-code fixture/operator expectation depends on the
   seed. (Engineering verifies code; operator confirms product expectation.)
6. **Descriptor signature scheme** (symmetric reuse of HMAC vs asymmetric) — mostly
   engineering (Step 10), but flagged if it affects the backend-ownership/trust
   story a payment provider would scrutinize.

---

## Exit-criteria completion

| ADR-015 criterion | Status |
|---|---|
| 1 — symbol-level disposition | ✅ (both dirs, every export) |
| 2 — importer inventory (genericize/move/delete/defer) | ✅ |
| 3 — External Backend Definition + descriptor trust/rotation/revocation/failure | ✅ (model defined; 2 sub-questions → Step 10) |
| 4 — end-to-end trace (install→descriptor→visibility→invocation→result) | ✅ |
| 5 — MCP comparison | ✅ (deferred, D4 reaffirmed) |
| 6 — legal/product questions | ✅ (6 questions enumerated) |

**Step 9 is complete.** The Step 10 implementation plan may now be drafted
(roadmap gate satisfied). The two §3 sub-questions and the Crit-6 items are
inputs/approval-gates for Steps 10–16, not blockers on drafting Step 10.

## Sequencing implication for Steps 10–16 (observed, not decided here)
- The type-level-only coupling of `traderton/` means Step 11 (generic client
  migration) is largely mechanical renaming + a config→registry change.
- The hard-coded trading `if`-branches (Crit 4b) are the real genericization
  surface and concentrate in `skills.ts`, `provider-catalog.ts`,
  `agent-runtime-descriptor.ts`, and worker `runtime-composition`/`agent.ts` —
  these feed Step 12 (descriptor-gated deep integration) and Step 14 (remove
  first-party trading).
- The `trading-protocol.ts` / `agent-protocol.ts` / `config/schema.ts`
  re-export indirection must be untangled early in Step 15 (split).

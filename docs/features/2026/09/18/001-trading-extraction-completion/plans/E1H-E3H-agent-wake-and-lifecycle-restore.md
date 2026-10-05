# Plan E1H-E3H: Restore agent-actor lifecycle + scanner wake delivery

- **Goal:** hybrid / `scanner_gated` agents (e.g. the local agent `thyper`) trade again. Today they never receive a scanner wake, so they log `Hybrid agent: timer tick without wake signal — skipping LLM dispatch` forever.
- **Repos:** herobids `/Users/chinomso.ikwuagwu/dev_ai/herobids` (most work) and traderton `/Users/chinomso.ikwuagwu/dev_ai/traderton` (Part T only).
- **Status:** NOT STARTED. This document is the human authorization to execute both GATED halves (traderton plans' "E1-H" and "E3-H").
- **Audience:** an implementing agent with NO prior context. Everything you need is here; facts marked *(verified)* were checked against the code on 2026-10-05. Line numbers are approximate — search for the named symbol.

---

## How to run this plan (read first)

**Autonomy contract.** Execute Parts T → A → L → R → B → C → V in order without asking for confirmation. Every design decision is already made below (see "Decisions already made"). When you hit something this plan did not anticipate, choose the option that (1) preserves existing behaviour for callers that do not use the new fields, (2) fails safe (no trading rather than wrong trading), (3) is smallest — then record it in the "Implementation log" at the bottom of this file and continue.

**Only stop and ask the human if:**
1. Achieving a step would require a destructive operation: `docker compose down -v`, recreating a postgres container, running `reset-and-run*.sh` (they wipe the DBs — `thyper` would be lost), deleting rows outside test fixtures, or force-pushing.
2. A traderton behaviour contradicts a *(verified)* fact here in a way that changes the design (not just a renamed symbol or moved line).
3. `pnpm lint` / tests fail in code you did not touch and the failure blocks your gate (first confirm on a clean checkout of `HEAD` that it is pre-existing; if pre-existing and not blocking your own tests, record it and continue).

**Git.** In each repo: create branch `feat/e1h-e3h-agent-wake` from the current branch. Commit after each Part passes its gate (one atomic commit per Part, conventional message, e.g. `feat(worker): actor-event relay (E3-H)`). Never push. Never amend. Never `--no-verify`.

**Implementation log.** Append to the "Implementation log" section at the bottom of this file: every deviation, every assumption you had to make, every pre-existing failure, and the evidence for each gate (command + key output line).

**Conventions (both repos, from AGENTS.md).** TypeScript strict, ESM, no `any` / `@ts-ignore` / `as unknown as X` in new code, Zod at trust boundaries, never swallow errors (log or rethrow), every async loop reschedules itself in `finally`, error codes are dot-strings, test names describe behaviour. Operator config lives in `config/default.yaml` + Zod schema; no hard-coded tunables. If you add an env var, add its `.env*.example` twin in the same commit (none are expected).

**Commands.**
- herobids, repo root: `pnpm lint` (tsc --noEmit), `pnpm build`, focused tests `pnpm exec vitest run <file …>`, full unit `pnpm test`.
- traderton, repo root: `pnpm lint`, focused `pnpm exec vitest run <file …>` (single root vitest config), repository integration tests `pnpm test:integration` (starts throwaway postgres :55432 / redis :56379 — safe; never point integration tests at the xstack DB, they TRUNCATE tables).
- Live stacks (only in Part V and the per-Part live checks):
  - traderton xstack rebuild **without data loss**, from `/Users/chinomso.ikwuagwu/dev_ai/traderton`:
    `docker compose -p traderton_xstack -f docker-compose.yml -f ../herobids/docker/traderton-xstack.override.yml up -d --build migrate boundary`
    (never `down`, never `-v`, never include `postgres` in a recreate — its volume is anonymous).
  - herobids rebuild: read `scripts/shell/run/reset-and-run-xstack.sh` to get the exact compose file list / `EXTRA_COMPOSE_FILES` it uses for the xstack setup, then run `pnpm build` and `docker compose <same -f flags> up -d --build api worker` (no `down`, no `-v`). Agent runtime code (`apps/worker/src/agent.ts`, `runtime-composition.ts`) runs inside agent containers built from `docker build -f docker/Dockerfile.agent -t herobids-agent:latest .`; a running agent only picks up a new image when its session is restarted.
  - Container names (Compose defaults, unverified): `traderton_xstack-postgres-1`, `traderton_xstack-boundary-1`, `herobids-postgres-1`, `herobids-redis-1`, `herobids-worker-1`; agent containers `herobids-agent-<agentId>`. Confirm with `docker ps`. DB users/names: herobids from `DATABASE_URL` in `.env.ops.dev`; traderton from its `docker-compose.yml` (expected `-U traderton -d traderton`).
  - API auth for live checks: `POST $API/auth/login {email,password}` → `.token`, then `Authorization: Bearer $TOKEN` (pattern in `scripts/shell/tests/runtime-policy-e2e.sh`). Credentials: `TEST_EMAIL`/`TEST_PASSWORD` and `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env.ops.dev`. Agent start/stop: `POST /agents/:id/start`, `POST /agents/:id/stop`.
  - If the live stacks are not running or not reachable, start them with the non-destructive commands above. If that fails, do NOT reset; skip the live checks, record it in the log, and rely on the automated gates.

---

## Background

**System.** herobids runs AI agents. Trading was extracted into **traderton**, reached over an HMAC-signed REST boundary (consumer id `herobids`). A `hybrid` + `scanner_gated` agent only runs its LLM when a **scanner wake** (`agent.wake` with `source: 'scanner'`) arrives on its Redis stream `agent:outbound:{agentId}`.

**Root cause — four gaps** *(verified)*:
1. **No scan config reaches traderton.** herobids never sends `scanMode` / `creatorStrategy` to `set_agent_trading_profile`, so traderton's `agent_trading_profiles.scan_mode` is NULL and no scan loop starts.
2. **The traderton actor is never started.** It is built lazily on the first venue-resolving agent call (e.g. `submit_decision`), which a scanner_gated agent never makes. The consumer-only tool `start_agent_actor` exists for this; herobids never calls it (the in-process wiring was deleted by herobids commit `45271d28`; see `git show 45271d28^:apps/worker/src/index.ts`).
3. **Wakes can't come back.** Traderton writes `agent_wake` rows to its `consumer_notifications` outbox (read via `scan_consumer_notifications`); the herobids relay that republishes them was never built.
4. **Wake-buffer parse bug (herobids agent runtime).** `bufferWakeEnvelope` (`apps/worker/src/runtime-composition.ts`) reads `wakeId`/`source`/`context` from the stream envelope's top level, but `InstanceEventPublisher.publish` nests them under `envelope.payload`. A buffered wake therefore gets `source: 'unknown'`; when the tick drains it (`agent.ts` ~L2572) the scanner_gated gate (`agent.ts` ~L2935, `scanner_gated_suppress_wake`) suppresses it.

**Authoritative design docs** (consult if something here is ambiguous; this plan wins where it is more specific):
- traderton `docs/features/2026/10/04/001-wave-e-actor-events-and-lifecycle/003-e1-agent-scan-loop-plan.md` (E1-H, T1 ownership rule, T5 lifecycle tools)
- traderton `docs/features/2026/10/04/001-wave-e-actor-events-and-lifecycle/002-e3-consumer-event-channel-plan.md` (E3-H, event vocabulary)
- herobids `docs/tech/agents/wake-signal-and-technical-scan.md`

**Ownership rule.** herobids sends **creator inputs only** — `scanMode` and `creatorStrategy`. It NEVER sends `activeStrategy` / `active_strategy` (traderton derives it; traderton's schemas silently strip unknown keys, so a herobids test must enforce this).

---

## Decisions already made (do not re-open)

| # | Decision | Why |
|---|---|---|
| D1 | Traderton change T1: on a profile `set`, an **absent** `scanMode`/`creatorStrategy` = unchanged; an explicit **`null`** = clear. | Today `null` = unchanged, so herobids can never turn a scanner off (hybrid → intelligence would keep scanning). herobids currently omits both fields, so old behaviour is preserved. |
| D2 | Traderton change T2: `start_agent_actor` declares an optional `venueAccountId` param. | *(verified)* The boundary resolves the venue from the **Zod-parsed** payload; `z.object({})` strips `venueAccountId`, so owners with several accounts get `precondition.not_ready` ("ambiguous"). |
| D3 | `creatorStrategy` is `{presetKey, styleTier}` only when the agent's technical config equals the preset's resolution AND the agent does not target a swap venue; otherwise `{customTechnical}`. | Selecting a preset also writes `unified_config.technical`, so presence of `technical` proves nothing. *(verified)* Traderton's preset branch emits no `filters.networks`, so preset + `scanner_gated` on a swap venue (`jupiter`, `1inch`) always fails with `swap.network_unresolved`; `customTechnical` keeps herobids' connection-merged filters (incl. networks). Record a follow-up for preset identity on swap venues. |
| D4 | `customTechnical` is normalised with herobids `TechnicalConfigSchema.parse` before sending, and compared by canonical JSON. | Traderton stores `creatorStrategy` after parsing (defaults filled). Without normalisation every save would look changed → revision bump → actor rebuild churn. |
| D5 | Lifecycle calls from the worker are fire-and-forget with a short deadline; they never block or fail a session transition. | `onSessionActive` is awaited inside heartbeat handling; a slow call would delay activation and a `false` return retries every heartbeat. |
| D6 | Profile-driven lifecycle calls (start after a profile change on a live agent, stop when an agent's last profile is cleared — incl. delete) go through ONE post-commit hook on the API saga. | The saga is the single place every profile write passes through (10 call sites). |
| D7 | Worker stop calls are skipped when the agent already has a newer non-terminal session. | Prevents a late stop for an old session killing the new session's actor. (DB index `uq_agent_runtime_sessions_active_agent` allows one non-terminal session per agent, so this is a race guard, not multi-session support.) |
| D8 | The relay persists its cursor in Redis, processes only rows older than a settle lag, merges `seenIds`, and uses throwing publish variants. | Replay after restart, out-of-order commits, and swallowed XADD errors would otherwise drop or duplicate wakes. |
| D9 | Backfill is a CLI inside `apps/api` (dry-run by default) reusing the API's saga construction. | `scripts/` cannot import API services; no automatic re-send exists. |
| D10 | Missed-stop reconciliation (an actor whose stop was never delivered) is a recorded follow-up, not built here. | Needs a new traderton read tool; out of scope. |

---

## PART T — traderton changes (repo: traderton)

### T1. Absent = unchanged, `null` = clear (D1)

Files: `packages/worker/src/tools/trading-profiles.ts`, `packages/db/src/agent-trading-profile-repository.ts`, `packages/db/src/schema/agent-trading-profiles.ts` (`AgentTradingProfileForwardAction` type).

1. `ForwardSetActionSchema`: change `scanMode: ScanModeSchema.nullable().default(null)` → `ScanModeSchema.nullable().optional()`; same for `creatorStrategy`. Leave `ForwardClearActionSchema` unchanged (clear stays `z.null().default(null)`). Leave `SetProfileSchema`'s `.nullish()`.
2. `setActions`: copy `params.scanMode` / `params.creatorStrategy` through as-is (remove `?? null`). When the value is `undefined`, OMIT the key from the action object (so `JSON.stringify` in `validateCurrentAction` matches a manifest entry that also omitted it).
3. `AgentTradingProfileForwardAction` (set variant): `scanMode?: ScanMode | null; creatorStrategy?: CreatorStrategy | null`.
4. Repository `applyOperation` set branch:
   ```ts
   const scanMode = action.scanMode === undefined ? (profile?.scanMode ?? null) : action.scanMode;
   const creatorStrategy = action.creatorStrategy === undefined ? (profile?.creatorStrategy ?? null) : action.creatorStrategy;
   ```
5. `deriveActiveStrategy`: `undefined` → keep stored (`profile?.activeStrategy ?? null`); explicit `null` → `null`; unchanged canonical JSON → keep stored; else resolve (unchanged logic).
6. Persisted manifests: before persisting a forward action and before `sameManifest`/`canonicalJson` comparison, drop keys whose value is `undefined` (jsonb drops them; an in-memory `undefined` would otherwise cause a spurious `TradingProfileOperationConflictError` on replay).
7. `validateScanConfiguration` call site: compute the **effective** values with the same rule as step 4, validate only when the effective `scanMode` is non-null, and pass `existingActive = null` when `creatorStrategy` is explicitly `null`.
8. Legacy replays: forward actions persisted before T1 carry `scanMode: null`, which T1 now reads as "clear". This is safe because nothing has ever written a non-null `scan_mode` from herobids; record this reasoning in the commit message.

Tests — extend `packages/worker/src/tools/trading-profiles.test.ts` (mocked repo, no DB) and `packages/db/src/agent-trading-profile-repository.integration.test.ts` (DB via `pnpm test:integration`):
- "omitted scanMode and creatorStrategy preserve the stored values" (update the existing old-caller assertion at ~L206: forward fields are now absent, not null)
- "explicit null scanMode clears the stored scan mode"
- "explicit null creatorStrategy clears creator and active strategy"
- "scanner_gated with an explicit null creatorStrategy is rejected with validation.strategy_required even when an active strategy is stored"
- "a replayed manifest with omitted scan fields does not raise an operation conflict"

### T2. `start_agent_actor` accepts `venueAccountId` (D2)

File: `packages/worker/src/tools/agent-lifecycle.ts`. Change `StartAgentActorParamsSchema = z.object({})` to `z.object({ venueAccountId: z.string().min(1).optional().describe('Venue account to start the actor on; defaults to the owner default') })`. No other change (the subject resolver already reads `venueAccountId` from the parsed payload and validates ownership).

Test (add to the existing lifecycle/boundary test that covers `start_agent_actor`, or create `packages/worker/src/tools/agent-lifecycle.test.ts`): "start_agent_actor keeps venueAccountId in the parsed payload". If a boundary-level test harness for venue resolution exists (search `venueAccountIdOf` tests in `packages/boundary`), add: "start_agent_actor resolves the requested venue account for an owner with several accounts".

### T3. Swap preset regression test

Add to `trading-profiles.test.ts`: "rejects preset creatorStrategy with scanner_gated on a swap venue (swap.network_unresolved)" and "accepts customTechnical with filters.networks ['solana'] on jupiter". These lock D3's premise.

**Gate T:** `pnpm lint` and `pnpm exec vitest run packages/worker/src/tools/trading-profiles.test.ts packages/worker/src/tools/agent-lifecycle.test.ts` green; `pnpm test:integration` green. Commit. Deploy to the xstack with the non-destructive rebuild command and confirm `docker logs traderton_xstack-boundary-1 --tail 50` shows a clean start.

---

## PART A — herobids sends scan config with every profile write (repo: herobids, `apps/api` + `packages/domain`)

### A1. Domain types

In `packages/domain/src/config/schema.ts`, next to `HybridModeSchema` (~L2427), add and export (also from the package index if the file's other exports are re-exported there):
```ts
export const ScanModeSchema = z.enum(['scanner_gated', 'mixed']);
export const CreatorStrategySchema = z.union([
  z.object({ presetKey: z.string().min(1), styleTier: z.string().min(1) }).strict(),
  z.object({ customTechnical: TechnicalConfigSchema }).strict(),
]);
export type ScanMode = z.infer<typeof ScanModeSchema>;
export type CreatorStrategy = z.infer<typeof CreatorStrategySchema>;
```
(Mirrors traderton `packages/domain/src/config/agent-strategy.ts`.)

### A2. Scan-config helper

New file `apps/api/src/agents/profile-scan-config.ts`:
```ts
export interface ProfileScanConfig { scanMode: ScanMode | null; creatorStrategy: CreatorStrategy | null }
export function deriveProfileScanConfig(input: { unifiedConfig: UnifiedAgentConfig | null; style: string | null }): ProfileScanConfig
```
Rules (input is the unified config that THIS operation will persist — the post-mutation state):
1. If `unifiedConfig?.capabilityMode !== 'hybrid'` → `{ scanMode: null, creatorStrategy: null }`.
2. `scanMode = unifiedConfig.hybridMode ?? 'mixed'` (create normalization defaults hybrid agents to `'mixed'`).
3. `technical = unifiedConfig.technical`. If absent → `creatorStrategy: null` (traderton rejects scanner_gated without a strategy; the route surfaces it as 400 via A5).
4. `isSwap = technical.filters.venueType === 'swap' || SWAP_VENUES.includes(technical.filters.venue)` (`SWAP_VENUES` from `@herobids/domain`).
5. Preset candidate: `presetKey = metadata?.strategyPreset` (metadata lives on the unified config object; read it the way `strategy-preset-resolver.ts` writes it). `presetStyle = isStyleKey(metadata?.strategyPresetStyle) ? metadata.strategyPresetStyle : agentStyleToPresetStyle(style ?? 'balanced')` (both from `@herobids/domain`).
6. If `presetKey` and `!isSwap`: resolve `presetTechnical = applyPresetToAgent(presetKey, getPreset(presetKey, presetStyle), presetStyle, 'llm').technical` (`getPreset` from `@herobids/domain/config/presets-loader`; wrap in try/catch — unknown preset → null, `dca` throws → treat as no match). If both `TechnicalConfigSchema.parse({ ...presetTechnical, filters: technical.filters })` and `TechnicalConfigSchema.parse(technical)` have equal canonical JSON → `{ presetKey, styleTier: presetStyle }`.
7. Otherwise → `{ customTechnical: TechnicalConfigSchema.parse(technical) }` (D4).
8. Never produce `activeStrategy`.

Add a `canonicalJson` helper (sorted keys) in the same file if none exists in `apps/api` (search first; reuse if present).

### A3. Snapshot model

`apps/api/src/agents/trading-profile-reconciliation.ts`:
- Add `scanMode: ScanMode | null; creatorStrategy: CreatorStrategy | null` to BOTH `TypedTradingProfile` and `TradingProfileConfiguration` (required, so tsc flags every builder).
- `sameSnapshot`: also compare `left.scanMode === right.scanMode` and `canonicalJson(left.creatorStrategy) === canonicalJson(right.creatorStrategy)`.
- `proposeTradingProfiles`: add a required input `scanConfig: ProfileScanConfig`; stamp `scanMode`/`creatorStrategy` from it onto every proposed profile (after `overlayTradingProfile`). The default base object gets them too.
- Do NOT add scan fields to `TradingProfileChanges`.

`apps/api/src/agents/trading-profile-reconciliation-saga.ts`:
- `AgentTradingProfileResponseSchema`: add `scanMode: ScanModeSchema.nullable().optional()` and `creatorStrategy: CreatorStrategySchema.nullable().optional()`.
- `readCurrentProfiles`: map them into the returned `TypedTradingProfile` (`?? null`).
- `applyForward`: no structural change — top-level payload and manifest set entries are both spreads of the snapshot, so they carry identical explicit values (never `undefined`). Clear manifest entries: leave as-is (traderton defaults them to null).

### A4. Every profile write path

Each site must compute `scanConfig = deriveProfileScanConfig({ unifiedConfig: <post-mutation unified config>, style: <post-mutation style> })` and either pass it to `proposeTradingProfiles` or set the two fields on inline-built profiles. `pnpm lint` will list every site after A3; this table is the expected set *(verified)*:

| # | Site | What to use |
|---|---|---|
| 1 | `apps/api/src/routes/agents.ts` `POST /agents` → `prepareCreateProfilePlan` (inline profiles ~L763) | the unified config + style computed for the insert (request scope) |
| 2 | `agents.ts` `PATCH /agents/:id` → `preparePatchProfilePlan` (`proposeTradingProfiles` ~L1751 and ~L1779) | the PATCHED unified config/style (after preset re-application, hybridMode/capabilityMode changes) — not the stored row |
| 3 | `agents.ts` `DELETE /agents/:id` (~L2015) | nothing (proposed map is empty → only clears) |
| 4 | `apps/api/src/routes/connections.ts` `DELETE /connections/:id` (~L467/478) | widen the `affectedAgents` select (~L447, already joins `agents`) to include `unifiedConfig` and `style` |
| 5 | `apps/api/src/services/agent-config-service.ts` `grantConnection` (~L166/178) | load the agent's `unifiedConfig`, `style` by `agentId` (extend `prepareConnectionChange`'s select ~L65) |
| 6 | `agent-config-service.ts` `revokeConnection` (~L226/235) | same as #5 |
| 7 | `apps/api/src/services/agent-go-live-service.ts` `cloneAgentAsLive` `preparePlannerInput` (~L310) | the unified config the live clone will be inserted with; if it is only assembled inside `commitLocal` (~L282), hoist that pure computation above `executeStaged` and reuse it in both places |
| 8 | `apps/api/src/routes/agent-interactivity.ts` `PUT /agents/:id` (inline overlay ~L313) | the updated agent's unified config/style |
| 9 | `apps/api/src/routes/chat.ts` `create_agent` (~L1390) | the unified config that will be inserted (from the same normalization the insert uses) |
| 10 | `apps/api/src/routes/blueprints.ts` agent instantiate (~L2277) | the unified config that will be inserted |
| — | `apps/api/src/__tests__/functional/helpers.ts` (~L407) and test fixtures | add `scanMode: null, creatorStrategy: null` |

Saga recovery (`recover`) replays stored rows only: no change.

### A5. Map scan validation errors to 400

In the saga's `applyForward` failure branch, next to the `validation.risk_ceiling` check, throw a new exported `TradingProfileScanValidationError` (code from `details.errorCode`) when `result.kind === 'failure'` and `details.errorCode` is one of `validation.strategy_required`, `validation.technical_config`, `validation.unknown_preset`, or starts with `swap.`. In every place that currently maps `TradingProfileCeilingViolationError` to 400 (`agents.ts` ~L881 and ~L1923, `agent-go-live-service.ts` ~L332, `agent-interactivity.ts` ~L334), map `TradingProfileScanValidationError` the same way (`{ error: 'validation_error', message }`). Do not add mappings where the ceiling error is not mapped today.

### A6. Tests (herobids)

- New `apps/api/src/agents/profile-scan-config.test.ts`: "returns null scan config for an intelligence agent"; "uses hybridMode as scanMode and defaults to mixed"; "sends presetKey and styleTier when technical equals the preset resolution"; "sends customTechnical when technical overrides a selected preset"; "sends customTechnical for a preset agent on a swap venue"; "sends customTechnical normalised with schema defaults"; "never returns an activeStrategy key".
- `trading-profile-reconciliation.test.ts`: "a scan-only change produces an upsert"; "an unchanged scan config produces no upsert"; "proposeTradingProfiles stamps the scan config on every proposed profile".
- `trading-profile-reconciliation-saga.test.ts`: "readCurrentProfiles preserves scanMode and creatorStrategy"; "the set payload and its manifest entry carry identical explicit scan fields"; "the set_agent_trading_profile payload contains no activeStrategy or active_strategy key at any depth"; "a swap.network_unresolved failure surfaces as TradingProfileScanValidationError".
- Route/service tests (existing files; mocks follow the stubs already there): `agents.test.ts` "PATCH switching hybrid to intelligence sends explicit null scanMode"; `agent-config-service.test.ts` "granting a connection sends the agent's scan config"; `connections.test.ts` "deleting a connection re-sends the remaining agents' scan config".

**Gate A:** `pnpm lint`, `pnpm build`, and the files above via `pnpm exec vitest run …` green; then `pnpm test` green (or only pre-existing failures, logged). Commit.

---

## PART L — Agent-actor lifecycle (repo: herobids, `apps/api` + `apps/worker`)

Facts *(verified)*:
- `start_agent_actor` / `stop_agent_actor` need an **agent** subject `{ ownerId, actor: { type: 'agent', id: agentId } }` (traderton only attaches the lifecycle context for `actor.type === 'agent'`). The boundary dedups by `(ownerId, toolName, idempotencyKey)` and replays the stored result, so use `crypto.randomUUID()` per call — never an agent-scoped key.
- `start` constructs/starts the actor (ensure) before recording `running`; if the actor already runs on the same profile revision it is a no-op; if the revision changed it rebuilds the actor (picks up new scan config). Missing profile / no `executionDefaults.mode` → `precondition.not_ready` (retryable).
- `stop` marks stopped, stops/evicts the actor, cascade-stops the agent's running bots, returns `{ stoppedBots }`; idempotent.
- Traderton rehydrates `running` actors on boot and its orphan sweep re-ensures dead `running` actors. There is no TTL: an undelivered stop leaves the scanner running (D10).

### L1. API: post-commit lifecycle hook on the saga (D6)

1. `TradingProfileReconciliationSaga` constructor: add an optional third param `hooks?: { onProfilesCommitted?(event: ProfilesCommittedEvent): Promise<void> }` with
   ```ts
   interface ProfilesCommittedEvent { ownerId: string; actorId: string; upserted: number; cleared: number; remainingProfiles: number; executionVenueAccountId: string | null }
   ```
2. In `executeStaged`, after `execute` resolves successfully and only if `plan.upserts.length + plan.clears.length > 0`: compute `remainingProfiles = buildTradingProfileSnapshots(plannerInput.proposed.profiles, plannerInput.proposed.connections).length` and `executionVenueAccountId = plan.selectedBinding.next?.venueAccountId ?? null`; then `await hooks.onProfilesCommitted(event)` inside try/catch that logs and swallows (the profile write already succeeded; never fail the request). `recover()` does not call the hook.
3. New file `apps/api/src/agents/agent-actor-lifecycle-hook.ts` exporting `createAgentActorLifecycleHook({ client, db, timeoutMs, logger })`:
   - if `remainingProfiles === 0 && cleared > 0` → invoke `stop_agent_actor` (payload `{}`).
   - else if `upserted > 0 && executionVenueAccountId` and `new AgentRepository(db).getCurrentSession(actorId)` is non-null → invoke `start_agent_actor` with `{ venueAccountId: executionVenueAccountId }`.
   - invocation: `client.invoke({ toolName, payload, subject: { ownerId, actor: { type: 'agent', id: actorId } }, idempotencyKey: crypto.randomUUID(), deadlineMs: timeoutMs })`; log non-success results at `warn` with the error code; never throw.
4. Wire it in `apps/api/src/index.ts` where `profileReconciliationSaga` is constructed (~L228), only when `tradingBackendClient` is defined, with `timeoutMs = tradingBackendTimeoutMs`. Use the API's existing logger.

This covers: connection granted to a running agent, scan-config change on a running agent (start → ensure sees the new revision → rebuild), last connection revoked/deleted, and agent delete (stop after clear is fine: `stop` needs no profile).

### L2. Worker: lifecycle helper

New file `apps/worker/src/agents/agent-actor-lifecycle.ts`:
```ts
export class AgentActorLifecycle {
  constructor(deps: {
    boundary: ExternalBackendWriteBoundary | undefined;   // `sideEffectBoundary` in index.ts
    agentRepo: Pick<AgentRepository, 'getAgent' /* name as found */ | 'getCurrentSession'>;
    resolveVenueAccountId: (agentId: string) => Promise<string | null>; // reuse the function behind `approvalVenueAccountResolver`
    deadlineMs: number;
    logger: Logger;
  })
  start(agentId: string, reason: string): Promise<void>
  stop(agentId: string, reason: string, stoppedSessionId?: string): Promise<void>
}
```
- Both methods catch everything and log; they never reject.
- No-op (debug log) if `boundary` is undefined.
- `ownerId = agent.userId`; empty → warn and return.
- `start`: `venueAccountId = await resolveVenueAccountId(agentId)`; null → debug log "not trading-capable", return. Invoke `start_agent_actor` with `{ venueAccountId }`.
- `stop`: `current = await agentRepo.getCurrentSession(agentId)`; if `current && current.id !== stoppedSessionId` → debug log "newer session live", return (D7). Invoke `stop_agent_actor` with `{}`.
- Invoke via `boundary.invokeAndAwait({ toolName, payload, subject: { ownerId, actor: { type: 'agent', id: agentId } }, idempotencyKey: crypto.randomUUID(), deadlineMs })`.
- Use the actual method name the agent repository exposes for loading one agent (see how `agent-decision-handler.ts` gets `agent.userId`).

### L3. Worker wiring (`apps/worker/src/index.ts`)

- Construct `AgentActorLifecycle` after `sideEffectBoundary` and `approvalVenueAccountResolver` (~L443–538) with `deadlineMs = appConfig.agentActorLifecycle.deadlineMs`. If `approvalVenueAccountResolver` is an inline lambda, extract it to a named const so both consumers share it.
- `onSessionActive` (~L692): keep existing behaviour; add `void agentActorLifecycle.start(agentId, 'session_active');` and keep returning `true` (never return `false` because of lifecycle). This also re-fires after a worker restart (the in-memory `activatedSessions` guard is empty), which is a harmless idempotent reconcile.
- `onSessionStopped` (~L710): add `void agentActorLifecycle.stop(agentId, 'session_stopped', sessionId);`.
- `DockerAgentManager` `onAgentCrashed` (~L362): after `sessionManager.handleAgentCrashed(...)`, add `void agentActorLifecycle.stop(agentId, 'agent_crashed', sessionId);` (`handleAgentCrashed` does not call `onSessionStopped`).
- `AgentHealthMonitor` (~L762): wire `onTerminalSessionCleanup: (agentId, sessionId) => agentActorLifecycle.stop(agentId, 'terminal_cleanup', sessionId)` (constructor option — check the constructor's options object; this hook exists but is unwired). This is the path that catches API-initiated stops (the API flips the DB directly, so `stopSession` early-returns without `onSessionStopped`). Replace the "No terminal-cleanup hook is needed here anymore" comment.
- Duplicate stops for one event are expected and harmless.

### L4. Config

`packages/domain/src/config/schema.ts`: add `AgentActorLifecycleConfigSchema = z.object({ deadlineMs: z.number().int().positive().default(5000) })` (JSDoc like `AlertsConfigSchema` ~L515) and register `agentActorLifecycle: AgentActorLifecycleConfigSchema.default({})` in `AppConfigSchema` (~L1575, next to `alerts`). `config/default.yaml`: add the block with an inline comment.

### L5. Tests

- New `apps/worker/src/agents/agent-actor-lifecycle.test.ts` (fake boundary like `makeBoundary` in `external-backend/write-adapter.test.ts`): "starts the actor with the resolved venueAccountId and an agent subject"; "uses a fresh idempotency key for every call"; "skips start for an agent with no ready trading connection"; "never rejects when the boundary fails or times out"; "skips stop when a newer session is live"; "stops when the stopped session is the current one or none is live"; "is a no-op when the boundary is not configured".
- New `apps/api/src/agents/agent-actor-lifecycle-hook.test.ts`: "stops the actor when the last profile is cleared"; "starts the actor after an upsert on an agent with a live session"; "does not start the actor when the agent has no live session"; "does not stop when profiles remain after a partial revoke"; "logs and resolves when the boundary call fails".
- Saga test: "calls onProfilesCommitted after a successful staged write with counts and binding"; "does not call onProfilesCommitted for a no-op plan or a failed write"; "a failing hook does not fail executeStaged".

**Gate L:** `pnpm lint`, `pnpm build`, focused tests, `pnpm test` green. Commit.

---

## PART R — Fix the wake-buffer parse (repo: herobids, agent runtime)

This is the ONLY change allowed in the runtime wake consumer. Do not change consumer groups, `agent.ts` gating, or tick gates.

`apps/worker/src/runtime-composition.ts` `bufferWakeEnvelope(envelope, receivedAt)`:
- Keep `type !== 'agent.wake'` → `null`.
- `const parsed = AgentWakePayloadSchema.safeParse(envelope['payload'])` (`AgentWakePayloadSchema` from `@herobids/domain`). On success build the entry from `parsed.data` (`wakeId`, `source`, `reason`, `requestedAt`, `context`).
- On failure fall back to the current top-level reads (legacy flat envelopes keep working).
- Update the doc comment's NOTE accordingly.

Tests in `apps/worker/src/runtime-composition.test.ts` (describe `wake-context buffering and drain`, fixture `scannerEnvelope` ~L3289): add a `publishedScannerEnvelope` fixture shaped exactly like `InstanceEventPublisher.publish` output (`{ schemaVersion, messageId, correlationId, initiatorType, initiatorId, agentId, type: 'agent.wake', createdAt, payload: <valid scanner AgentWakePayload> }`). Tests: "buffers a published scanner wake with source scanner"; "drains a published scanner wake into currentMarketWake with source scanner"; "still buffers a legacy flat envelope". Keep existing tests.

**Gate R:** `pnpm lint`, `pnpm exec vitest run apps/worker/src/runtime-composition.test.ts` green. Commit.

---

## PART B — Actor-event relay (repo: herobids, `apps/worker`)

Traderton facts *(verified)*:
- `scan_consumer_notifications` params `{ cursor?: { createdAt: ISO string, seenIds: string[] }, types?: string[], limit: 1..500 }`; omitting `cursor` scans from the start of the table. Returns `{ ok: true, notifications: Row[] }`, `Row = { id, type, ownerId, agentId: string|null, botId: string|null, payload, createdAt }` ordered by `(createdAt, id)` ascending. Query semantics: with non-empty `seenIds` → `createdAt >= cursor AND id NOT IN seenIds`; empty → `createdAt > cursor`.
- `created_at` is DB `now()` per insert from many concurrent writers (rows can commit out of order); ids are random UUIDs; rows are pruned after 7 days; no consumer column.
- Payloads (routing ids are columns, not payload fields):

  | type | payload |
  |---|---|
  | `agent_wake` | `{ wake: AgentWakePayload }` |
  | `scan_completed` | `{ scan: TechnicalScanState & { signalsTruncated?: boolean } }` |
  | `journal_event` | `{ journalType: string, detail: string /* JSON string */ }` |
  | `bot_status` | `{ status: 'stopped'|'crashed', reason: string, managedBots: {id,status}[] }` |
  | `agent_status` | `{ status: 'crashed', error: string }` |

herobids facts *(verified)*: `InstanceEventPublisher.publish` catches and only logs XADD errors; `UserEventPublisher.publish` likewise; `emitInstanceStatus` payload requires `updatedAt` (ISO) and accepts status `stopped|crashed`; `TechnicalScanState` is exported from `apps/worker/src/runtime-composition.ts`; `sessionManager.handleRuntimeFailure(sessionId, agentId, userId|undefined, err)`; `agentRepo.getActiveSession(agentId)` returns the `running` session with `startedAt`.

### B1. Throwing publish variants

- `apps/worker/src/agents/instance-event-publisher.ts`: extract the XADD into `private async publishStrict(agentId, type, payload)` that rethrows; `publish` = `publishStrict` + catch/log (existing behaviour unchanged). Add public `emitAgentWakeStrict`, `emitTechnicalScanCompletedStrict`, `emitJournalEventStrict`, `emitInstanceStatusStrict` with the same signatures/types as their lenient twins.
- `apps/worker/src/user-event-publisher.ts`: same pattern; add `publishBotStatusStrict(userId, botId, status)`.
- Tests: "strict publish rejects when XADD fails"; "lenient publish still only logs" (both publishers, existing test files).

### B2. Relay

New file `apps/worker/src/agents/actor-event-relay.ts`, class `ActorEventRelay`, modelled on `apps/worker/src/alerting/alert-dispatcher.ts` (copy its lease acquire `SET NX EX`, Lua compare-and-renew, Lua compare-and-delete on stop, and "stop awaits the in-flight tick").

- Constants: lease key `lease:actor-event-relay`, lease TTL 30s; cursor key `actor-event-relay:cursor`.
- Deps (constructor injection): `config: ActorEventRelayConfig`, `feed: ConsumerNotificationFeed`, `eventPublisher`, `userEventPublisher`, `sessionManager` (`handleRuntimeFailure`), `agentRepo` (`getActiveSession`), `redis`, `workerId`, `logger`, `now: () => number` (default `Date.now`, for tests).
- `ConsumerNotificationFeed` port + adapter in new file `apps/worker/src/agents/boundary-consumer-notification-feed.ts`, modelled on `apps/worker/src/alerting/boundary-trade-event-feed.ts` (throws on non-success so the cursor holds). It calls `scan_consumer_notifications` with `{ cursor, types: ['agent_wake','scan_completed','journal_event','bot_status','agent_status'], limit }` and Zod-validates the row envelope (`createdAt` → `Date`).
- `start()`: no-op if `!config.enabled`; else `setTimeout`-based loop: `tick()` then reschedule in `finally` after `pollIntervalMs`.
- `tick()`:
  1. Acquire/renew the lease; not holder → return.
  2. Load cursor from Redis (JSON). Absent → `{ createdAt: new Date(now() - settleLagMs).toISOString(), seenIds: [] }` and persist it (document in a comment: herobids/traderton clocks assumed NTP-synced; skew beyond `settleLagMs` can drop or replay rows, replayed wakes are filtered by the stale guard).
  3. `rows = await feed.scan({ cursor, limit: maxBatchSize })`.
  4. `horizon = now() - settleLagMs`; process rows in order and STOP at the first row with `createdAt > horizon` (do not process or pass it).
  5. For each processed row: Zod-validate the payload for its type; invalid → `logger.warn` (id, type) and treat as handled. Stale (`agent_wake`/`scan_completed` with `now() - createdAt > maxEventAgeMs`) → debug log, handled. Otherwise republish (table below) using the **strict** variants. If a republish throws → stop processing this batch, do NOT advance past this row, log `error`, return.
  6. Advance the cursor to the last handled row: `createdAtMs = lastRow.createdAt` truncated to milliseconds; `idsAtTs` = ids of handled rows whose ms timestamp equals `createdAtMs`; if `createdAtMs` equals the previous cursor's ms timestamp → `seenIds = union(previous.seenIds, idsAtTs)` else `seenIds = idsAtTs`. Persist with `SET`.
- Republish:

  | type | action |
  |---|---|
  | `agent_wake` | requires `agentId`; `emitAgentWakeStrict(agentId, payload.wake)` |
  | `scan_completed` | requires `agentId`; `emitTechnicalScanCompletedStrict(agentId, payload.scan)` |
  | `journal_event` | if `agentId`: `emitJournalEventStrict(agentId, { journalType, detail, timestamp: row.createdAt.toISOString() })`; else skip (debug) |
  | `bot_status` | if `agentId`: `emitInstanceStatusStrict(agentId, { status, reason, managedBots, updatedAt: row.createdAt.toISOString() })`; always (when `botId`): `publishBotStatusStrict(row.ownerId, row.botId, status)` |
  | `agent_status` | `session = await agentRepo.getActiveSession(agentId)`; if `session && row.createdAt >= session.startedAt` → `await sessionManager.handleRuntimeFailure(session.id, agentId, row.ownerId, new Error(payload.error))`; else info log "no matching live session", handled |

  A row missing a required `agentId` is treated as malformed. `managedBots` must satisfy `InstanceStatusPayloadSchema` — map `{id,status}` straight through.
- Never skip `bot_status` / `journal_event` / `agent_status` for age.
- Doc comment: rows older than traderton's 7-day retention are lost if the relay is down longer.
- `stop()`: clear the timer, await in-flight tick, release the lease.

### B3. Config + wiring

- `packages/domain/src/config/schema.ts`: `ActorEventRelayConfigSchema` with `.default()` per field: `enabled: true`, `pollIntervalMs: 5000`, `maxBatchSize: 100` (`.max(500)`), `maxEventAgeMs: 600000`, `settleLagMs: 5000`; register `actorEventRelay: ActorEventRelayConfigSchema.default({})` in `AppConfigSchema`. `config/default.yaml`: block with inline comments.
- `apps/worker/src/index.ts`: build the feed with a system read boundary exactly like `alertDispatcherFeed` (~L497) but actor id `actor-event-relay`; `undefined` when `tradingBackend` is not ok. Construct `ActorEventRelay` only when the feed exists; `await relay.start()` next to `alertDispatcher.start()` (~L924); `await relay?.stop()` next to `alertDispatcher?.stop()` in BOTH the SIGTERM and SIGINT handlers (~L1327, ~L1353).

### B4. Tests

New `apps/worker/src/agents/actor-event-relay.test.ts` (fake feed, fake publishers, hand-rolled `vi.fn()` Redis like `alert-dispatcher.test.ts`, injected `now`):
"republishes an agent_wake row onto the agent's outbound stream"; "republishes a scan_completed row"; "republishes a bot halt as instance status with managed bots and updatedAt"; "publishes user bot status for a user-created bot"; "initialises the cursor to now minus the settle lag"; "does not process or pass rows younger than the settle lag"; "does not advance the cursor when a republish fails"; "merges seenIds when the boundary timestamp is unchanged"; "skips stale wakes but delivers stale bot and journal events"; "fails the live session on an agent_status crash raised during it"; "ignores an agent_status crash from before the live session started"; "skips a malformed row and advances past it"; "does nothing when it does not hold the lease"; "reschedules after a feed failure".
New `boundary-consumer-notification-feed.test.ts`: "sends the cursor as an ISO string with the relay types"; "throws on a non-success result".

**Gate B:** `pnpm lint`, `pnpm build`, focused tests, `pnpm test` green. Commit.

---

## PART C — End-to-end herobids test

New `apps/worker/src/__tests__/integration/actor-event-relay.integration.test.ts` (this directory runs under `pnpm test:functional`; `describe.skipIf(!process.env.REDIS_URL)` like `outbound-message-reader.integration.test.ts`). Run it against the herobids dev Redis (port from the herobids compose file) or a throwaway `redis:7` container — never the traderton Redis.
1. Fake `ConsumerNotificationFeed` returns one `agent_wake` row (`createdAt` older than the settle lag) whose payload is a valid scanner `AgentWakePayload`.
2. Real `ActorEventRelay` + real `InstanceEventPublisher` on real Redis; run one `tick()`.
3. `XRANGE agent:outbound:{agentId}` contains an envelope with `type: 'agent.wake'` and the wake under `payload`.
4. Feed that envelope through both runtime paths: `bufferWakeEnvelope` → `drainNewestWakeIntoMarketWake` gives `source === 'scanner'`; `applyRuntimeMessage` sets `currentMarketWake.source === 'scanner'`; `buildTickGateState` (`apps/worker/src/tick-gate-state.ts`) returns `hasWakeSignal: true`.
5. A second `tick()` publishes nothing (cursor persisted).
6. Clean up the test stream and relay keys in `afterAll`.

Test header comment: real legs = relay → Redis → runtime parsing; stubbed = traderton outbox (fake feed). Record "full cross-stack CI leg" as a follow-up.

**Gate C:** the test passes with `REDIS_URL` set (paste the command and result in the log). Commit.

---

## PART V — Backfill + live verification

### V1. Backfill CLI (D9)

1. Extract the client + saga construction in `apps/api/src/index.ts` (~L214–240, plus the L1 hook) into an exported function in a new file `apps/api/src/agents/create-trading-profile-saga.ts` (returns `{ client, saga, timeoutMs } | undefined`); `index.ts` calls it (no behaviour change).
2. New `apps/api/src/bin/backfill-profile-scan-config.ts`: loads the API config + DB the same way `apps/api/src/index.ts` does; for each agent with ≥1 active trading-profile connection (`loadActiveTradingProfileConnections(db, agentId)` from `trading-profile-reconciliation-adapter.ts`), run `saga.executeStaged` with `localMutationId: backfill-scan-config:<agentId>:<uuid>`, `preparePlannerInput` = `{ prior: { profiles: await saga.readCurrentProfiles(ownerId, agentId, connections), connections }, proposed: { profiles: proposeTradingProfiles({ actorId, priorProfiles, priorConnections: connections, proposedConnections: connections, changes: {}, scanConfig: deriveProfileScanConfig(agent) }), connections } }`, `commitLocal: (_tx, mark) => mark()`. Without `--apply` only compute and print the plan per agent (`upserts`, `clears`). Print one line per agent: `sent | unchanged | failed <errorCode>`; exit non-zero if any failed. Processing continues after a failure.
3. Unit test `backfill-profile-scan-config.test.ts`: "dry run does not call the boundary"; "apply sends the scan config for an agent whose traderton profile lacks it"; "an unchanged agent is reported unchanged"; "one failure does not stop the remaining agents".
4. Run it inside the herobids `api` container (env already correct): find the compiled path (`docker compose <flags> exec api sh -c 'find / -name backfill-profile-scan-config.js -not -path "*/node_modules/*" 2>/dev/null'`), run once without `--apply`, then with `--apply`. If the container cannot reach traderton, run on the host with `pnpm --filter @herobids/api exec tsx src/bin/backfill-profile-scan-config.ts` after exporting the env from `.env.ops.dev` (log which you used).

### V2. Live checks (after rebuilding both stacks non-destructively)

Find ids: `SELECT a.id, a.name, a.status, a.user_id FROM agents a WHERE a.name ILIKE 'thyper%' OR a.name ILIKE 'tintel%';` (herobids DB) and the owner's email via `users`.

1. Traderton profile: `SELECT actor_id, scan_mode, creator_strategy IS NOT NULL AS has_creator, active_strategy IS NOT NULL AS has_active, revision FROM agent_trading_profiles;` → `thyper`: `scan_mode = scanner_gated`, both true; `tintel`: `scan_mode` NULL.
2. Restart the herobids worker (`docker compose <flags> restart worker`); within one heartbeat: `SELECT actor_id, desired_state FROM agent_actor_runs;` shows `thyper` `running`. `tintel` has a row only if it has a ready trading connection (start is skipped otherwise).
3. Within ~2 scan intervals: `SELECT type, count(*) FROM consumer_notifications GROUP BY type;` shows `scan_completed`, and `agent_wake` once signals fire (if no `agent_wake` after 15 minutes but `scan_completed` grows, that is market-dependent: log it and continue).
4. `docker exec herobids-redis-1 redis-cli XRANGE agent:outbound:<thyper-id> - + | grep -c '"type":"agent.wake"'` > 0 after an `agent_wake` row exists.
5. If you can authenticate as the owner (owner email equals `TEST_EMAIL` or `ADMIN_EMAIL` in `.env.ops.dev`): rebuild the agent image, `POST /agents/<thyper>/stop` then `/start` (loads Part R), and confirm `docker logs herobids-agent-<thyper-id>` shows LLM dispatch on a scanner wake and no `suppressing non-scanner wake` for scanner wakes. After stop: run row `stopped` within one health-monitor interval. If you cannot authenticate, skip step 5 and log it.
6. Idempotence: re-save `thyper` with no changes (only if authenticated: `PATCH /agents/<id>` with `{}` or the smallest no-op body the route accepts) → traderton `revision` unchanged.
7. Clean up any rows/keys you created for testing (not the agents' real data).

---

## Final verification (both repos)

- herobids: `pnpm lint`, `pnpm build`, `pnpm test`, Part C test command.
- traderton: `pnpm lint`, focused tests, `pnpm test:integration`.
- Re-read the gates above and confirm each has evidence in the log.

## Scope guards

- Traderton: only T1–T3.
- Agent runtime: only Part R.
- Never send `activeStrategy`.
- Lifecycle and relay never block or fail session transitions or profile writes after commit.
- `start_agent_actor` / `stop_agent_actor` / `scan_consumer_notifications` stay off every agent tool surface.
- Intelligence agents: only the `scanMode: null` change.

## Follow-ups (append to the active extraction plan when done)

1. Missed-stop reconciliation for orphaned traderton actors (D10).
2. `scan_consumer_notifications` and the lifecycle tools are system/consumer-only by convention: the `herobids` boundary consumer has no `allowedActorTypes` fence. Add one or a per-tool actor-type check in traderton.
3. Preset identity for swap venues (D3): traderton's preset branch should accept creator filters so swap agents can keep `{presetKey, styleTier}`.
4. Full cross-stack CI leg for Part C (real traderton scan → outbox → relay).

## References

- traderton: `packages/worker/src/tools/trading-profiles.ts`, `packages/db/src/agent-trading-profile-repository.ts`, `packages/worker/src/tools/agent-lifecycle.ts`, `packages/boundary/src/{dispatcher.ts,subject-resolver.ts,agent-direct-actor-ensure.ts,bin.ts}`, `packages/worker/src/tools/bots.ts` (`scan_consumer_notifications`), `packages/db/src/consumer-notification-repository.ts`, `packages/worker/src/composition/consumer-notifier.ts`, `packages/worker/src/swap-startup-validation.ts`, `packages/domain/src/config/agent-strategy.ts`
- herobids API: `apps/api/src/agents/{trading-profile-reconciliation.ts,trading-profile-reconciliation-saga.ts,trading-profile-reconciliation-adapter.ts,strategy-preset-resolver.ts,agent-create-normalization.ts}`, `apps/api/src/routes/{agents.ts,connections.ts,agent-interactivity.ts,chat.ts,blueprints.ts}`, `apps/api/src/services/{agent-config-service.ts,agent-go-live-service.ts}`, `apps/api/src/index.ts`
- herobids worker: `apps/worker/src/index.ts`, `apps/worker/src/agents/{agent-session-manager.ts,agent-health-monitor.ts,agent-decision-handler.ts,instance-event-publisher.ts}`, `apps/worker/src/user-event-publisher.ts`, `apps/worker/src/external-backend/write-adapter.ts`, `apps/worker/src/alerting/{alert-dispatcher.ts,boundary-trade-event-feed.ts}`, `apps/worker/src/{agent.ts,runtime-composition.ts,tick-gate-state.ts}`
- herobids domain/db: `packages/domain/src/config/{schema.ts,presets.ts,presets-loader.ts}`, `packages/domain/src/agent-protocol.ts`, `packages/domain/src/trading/trading-protocol.ts`, `packages/db/src/agent-repository.ts`
- `git show 45271d28^:apps/worker/src/index.ts` (pre-extraction wiring)

---

## Implementation log

(Implementer: append dated entries — gate evidence, deviations, assumptions, pre-existing failures.)

### 2026-10-05 — PART T (traderton) complete

Branch `feat/e1h-e3h-agent-wake` created in both repos from `main` (herobids d08ab623, traderton 4a25832), both clean.

T1 — `trading-profiles.ts`: `ForwardSetActionSchema.scanMode/creatorStrategy` now `.nullable().optional()` (was `.nullable().default(null)`); `ForwardClearActionSchema` unchanged. `setActions` omits an absent (undefined) scan key from the action object. The `set` tool's validation loop recomputes the EFFECTIVE scanMode/creatorStrategy with the absent=unchanged / null=clear rule (reads the stored profile), skips validation when effective scanMode is null, and passes `existingActive = null` when `creatorStrategy` is explicitly null. `agent-trading-profiles.ts`: forward-action type `scanMode?/creatorStrategy?` optional. Repository `applyAction` + `deriveActiveStrategy`: undefined→keep stored, null→clear. Added `stripUndefined` helper applied before persisting the forward action and inside `sameManifest`, so a replayed manifest (jsonb drops undefined keys) compares equal (no spurious `TradingProfileOperationConflictError`). `applyChange` also preserves the undefined/null distinction.

T2 — `agent-lifecycle.ts`: `StartAgentActorParamsSchema` gains optional `venueAccountId`. Verified (subject-resolver.test.ts "honours a payload-supplied venueAccountId even when the owner has multiple accounts and no default") that the resolver already honours a payload `venueAccountId`; the only gap was the schema stripping it. No boundary test added — that existing resolver test already locks the multi-account resolution; the new `agent-lifecycle.test.ts` "keeps venueAccountId in the parsed payload" locks the schema.

T3 — regression tests in `trading-profiles.test.ts`: preset+scanner_gated on jupiter → `swap.network_unresolved`; customTechnical with `filters.networks:['solana']` + canonical USDC on jupiter → success.

Deviation: the integration test `action()` helper previously hard-coded `scanMode:null/creatorStrategy:null` for set actions (the OLD "unchanged" encoding). Under T1 that now means "clear", so the helper was changed to OMIT scan keys unless explicitly provided in `extra` (explicit null still passes through for the clear-tests).

Gate T evidence:
- `pnpm lint` → exit 0 (tsc --noEmit).
- `pnpm exec vitest run packages/worker/src/tools/trading-profiles.test.ts packages/worker/src/tools/agent-lifecycle.test.ts` → 28 passed.
- `pnpm test:integration` → 58 passed, 1 skipped; `agent-trading-profile-repository.integration.test.ts` → 10 passed (incl. 4 new T1 cases).
- `pnpm exec vitest run packages/worker/src/tools packages/db/src` → 539 passed, 59 skipped.
- Commit `7392ae7`.
- Live xstack deploy of the traderton boundary deferred to Part V (bundled with the herobids live checks) to avoid an extra rebuild cycle.

### 2026-10-05 — PART A (herobids) complete

A1 domain types `ScanModeSchema`/`CreatorStrategySchema` + `ScanMode`/`CreatorStrategy` added next to `HybridModeSchema` in `packages/domain/src/config/schema.ts` and re-exported from `config/index.ts` (schema value block + type block).

A2 `apps/api/src/agents/profile-scan-config.ts`: `deriveProfileScanConfig` + `canonicalJson`. Preset identity only when the schema-parsed agent technical equals the schema-parsed `{...preset.technical, filters: agent.filters}` AND the venue is non-swap; else `customTechnical` (schema-normalised). Reads `metadata.strategyPreset`/`strategyPresetStyle` off the loose unified-config metadata.

A3 reconciliation + saga: scan fields on `TypedTradingProfile`/`TradingProfileConfiguration`, `sameSnapshot` (scanMode `===`, creatorStrategy canonicalJson), `proposeTradingProfiles` gains required `scanConfig` and stamps it onto every proposed profile (overriding template/existing), default base gets null scan fields. Saga `AgentTradingProfileResponseSchema` gains `scanMode`/`creatorStrategy` nullable+optional, `readCurrentProfiles` maps them. Set payload + manifest flow the fields automatically via the snapshot spread; clear branch leaves nulls.

A4 all 10 sites wired. #1 create guards the derive behind "has ≥1 resolvable connection" (an unbound create has no profile and no resolved venue). #2 patch computes the post-mutation unified config (`unifiedConfigPatch` when defined, else stored) and style once. #4 connections DELETE widened the affectedAgents select to carry unifiedConfig/style. #5/#6 extended `prepareConnectionChange`'s agent select + a `scanConfig` field on the `ready` result. #7 go-live reconstructs the live clone's unified config from `livePayload` + source metadata above `executeStaged`. #8 interactivity re-derives from the (unchanged) stored config. #9 chat and #10 blueprint derive from the insert config (blueprint carries no preset metadata → always customTechnical). Functional helper's `FunctionalProfile` + `getProfile` carry null scan fields.

A5 `TradingProfileScanValidationError` (code = failing errorCode) thrown in `applyForward` when `details.errorCode` is `validation.strategy_required|technical_config|unknown_preset` or `swap.*`; mapped to 400 in agents.ts (both ceiling sites), go-live, agent-interactivity. NOT added to chat/blueprints (they don't map the ceiling error either).

A6 tests: new `profile-scan-config.test.ts` (9); reconciliation.test.ts (+3 scan cases, existing exact-snapshot assertions updated with the two null fields); saga.test.ts (+4: readCurrentProfiles preserves scan, payload==manifest scan fields, no activeStrategy at any depth, swap.network_unresolved → scan validation error); agent-config-service.test.ts (+1 grant sends scan config); connections.test.ts (+1 delete re-sends scan config); agents.test.ts (+1 PATCH hybrid→intelligence sends explicit null scanMode).

Deviation (recorded): `deriveProfileScanConfig` fails safe — the final `TechnicalConfigSchema.parse` was changed to `safeParse` returning `creatorStrategy: null` on failure, because the create path can build a hybrid technical config with no resolved venue/venueType (unbound agent). Without this a pre-existing test ("does NOT populate technical.filters when creating agent without connections") turned 201→500. The site-#1 guard also skips the derive entirely when there are no connections.

Gate A evidence:
- `pnpm exec tsc --build` → 0 errors (root `pnpm lint`/`tsc --noEmit` passes but does not deep-check referenced projects; use `tsc --build` for apps).
- `pnpm build` → Done (all packages + apps).
- Focused: profile-scan-config (9), reconciliation (12), saga (38), agent-config-service (5), connections (39), agents (140) — all green.
- `pnpm test` → 6785 passed, 331 skipped, 0 failed.
- Commit `bf06eed7`.

### 2026-10-05 — PART L (herobids) complete

L1: `TradingProfileReconciliationSaga` constructor gains optional 3rd param `hooks?: { onProfilesCommitted? }`; `executeStaged` computes the plan once, passes it to `execute`, and (only when `upserts+clears > 0`) emits a `ProfilesCommittedEvent` (ownerId, actorId, upserted, cleared, remainingProfiles via `buildTradingProfileSnapshots(proposed)`, executionVenueAccountId via `plan.selectedBinding.next`). The hook call is wrapped in try/catch and swallowed. `recover()` doesn't touch `executeStaged`, so it never fires the hook. New `apps/api/src/agents/agent-actor-lifecycle-hook.ts` (`createAgentActorLifecycleHook`): stop when `remainingProfiles===0 && cleared>0`; start (with `{venueAccountId}`) when `upserted>0 && executionVenueAccountId` AND `getCurrentSession` is non-null. Fresh idempotency key per call; never throws. Wired in `apps/api/src/index.ts` only when `tradingBackendClient` is defined, with `timeoutMs = tradingBackendTimeoutMs`.

L2: `apps/worker/src/agents/agent-actor-lifecycle.ts` `AgentActorLifecycle` — `start`/`stop` catch everything and never reject; no-op when `boundary` undefined; `ownerId = agent.userId`; `start` resolves venueAccountId (null → debug + return); `stop` skips when a newer session is live (`getCurrentSession().id !== stoppedSessionId`, D7). Invokes `boundary.invokeAndAwait` with an agent subject + fresh idempotency key + `deadlineMs`.

L3: worker wiring in `index.ts`. `approvalVenueAccountResolver` was already a named const — reused directly as `resolveVenueAccountId`. `AgentActorLifecycle` constructed right after it. `onSessionActive` adds `void start('session_active')` (keeps returning true). `onSessionStopped` now uses the real `sessionId` and adds `void stop('session_stopped', sessionId)`. `DockerAgentManager.onAgentCrashed` adds `void stop('agent_crashed', sessionId)` after `handleAgentCrashed`. `AgentHealthMonitor` wired `onTerminalSessionCleanup: (agentId, sessionId) => stop('terminal_cleanup', sessionId)` (replacing the "no terminal-cleanup hook needed" comment) — this is the path that catches API-initiated stops.

L4: `AgentActorLifecycleConfigSchema` (deadlineMs default 5000) added before `AlertsConfigSchema`, registered as `agentActorLifecycle` in `AppConfigSchema`, type exported from schema + config index; `config/default.yaml` block added.

L5: `agent-actor-lifecycle.test.ts` (worker, 8), `agent-actor-lifecycle-hook.test.ts` (api, 6), saga tests (+4: emits event with counts/binding; no event for no-op plan; no event for failed write; a failing hook doesn't fail executeStaged).

Gate L evidence:
- `pnpm exec tsc --build` → 0 errors; `pnpm build` → Done.
- Focused: lifecycle (8), hook (6), saga (42) green.
- `pnpm test` → 6803 passed, 331 skipped, 0 failed.
- Commit `94c49d6a`.

### 2026-10-05 — PART R (herobids) complete

`bufferWakeEnvelope` now `AgentWakePayloadSchema.safeParse(envelope['payload'])`; on success builds the entry from `parsed.data` (validated `source`, typed `context`), on failure falls back to the previous top-level reads so legacy flat envelopes keep working. Doc comment NOTE updated to explain the nested-payload shape. Only the runtime wake consumer touched; `applyRuntimeMessage` already read `message['payload']` so the two paths now agree.

Confirmed `AgentWakePayloadSchema` (trading-protocol.ts) is a discriminated union on `source` with required `wakeId`/`reason`/`eventIds`/`priority`/`requestedAt`/`context` — so the published fixture must carry `eventIds` + `priority`.

Gate R evidence:
- `pnpm exec tsc --build` → 0 errors.
- `pnpm exec vitest run apps/worker/src/runtime-composition.test.ts` → 152 passed (3 new: buffers a published scanner wake with source scanner; drains it into currentMarketWake source scanner; still buffers a legacy flat envelope). Existing tests kept.
- Commit `150ec905`.

### 2026-10-05 — PART B (herobids) complete

B1: `instance-event-publisher.ts` — `publish` split into `publishStrict` (the XADD core, rethrows) + a lenient wrapper (logs/swallows, behaviour unchanged); added `emitAgentWakeStrict`/`emitTechnicalScanCompletedStrict`/`emitJournalEventStrict`/`emitInstanceStatusStrict`. `user-event-publisher.ts` — same split (`publishStrict`) + `publishBotStatusStrict`.

B2: `boundary-consumer-notification-feed.ts` — `ConsumerNotificationFeed` port + `createBoundaryConsumerNotificationFeed` adapter (calls `scan_consumer_notifications` with cursor/types/limit, Zod-validates the row envelope, rehydrates `createdAt`→Date, throws on non-success). `RELAY_NOTIFICATION_TYPES` exported. `actor-event-relay.ts` — `ActorEventRelay` modelled on `AlertDispatcher` (lease `lease:actor-event-relay` TTL 30s via SET NX EX + Lua renew/delete; `stop()` awaits the in-flight tick). Cursor persisted at `actor-event-relay:cursor`; init = `now - settleLagMs`. `tick()`: hold lease → load cursor → scan → stop at the first row younger than the settle lag → per row: Zod-validate payload (invalid → warn + handled), stale `agent_wake`/`scan_completed` by `maxEventAgeMs` → debug + handled, else republish via strict variants; a republish throw stops the batch and does NOT advance past the row. Cursor advances to the last handled row with the seenIds-merge-on-tie rule. Republish table exactly per plan (agent_wake/scan_completed require agentId; journal_event skips when no agentId; bot_status → instance status when agentId + user bot status when botId; agent_status → `handleRuntimeFailure` only when a live session started at/before the crash). `scan_completed` forwards the stored scan verbatim via a documented trust-boundary cast to `TechnicalScanState`.

B3: `ActorEventRelayConfigSchema` (enabled true / pollIntervalMs 5000 / maxBatchSize 100 max 500 / maxEventAgeMs 600000 / settleLagMs 5000) registered as `actorEventRelay` + type exported + `config/default.yaml` block. Worker wiring: `actorEventRelayFeed` built like `alertDispatcherFeed` with system actor id `actor-event-relay` (undefined when the backend is unresolved); `ActorEventRelay` constructed + `start()`ed next to the alert dispatcher; `actorEventRelay?.stop()` added to both SIGTERM and SIGINT.

B4: `actor-event-relay.test.ts` (14 — fake feed/publishers/Map-backed Redis/injected now), `boundary-consumer-notification-feed.test.ts` (3), strict/lenient publisher tests appended to `instance-event-publisher.test.ts` (+3) and new `user-event-publisher.test.ts` (3).

Deviation: the "does not advance the cursor when a republish fails" test asserts the cursor stays at its init value (`now - settleLag`) and omits the failed id, rather than comparing to a pre-tick undefined (the init write happens inside the tick).

Gate B evidence:
- `pnpm exec tsc --build` → 0 errors; `pnpm build` → Done.
- Focused: relay (14), feed (3), instance-event-publisher (17), user-event-publisher (3) green.
- `pnpm test` → 6829 passed, 331 skipped, 0 failed.
- Commit `02def8d9`.

### 2026-10-05 — PART C (herobids) complete

New `apps/worker/src/__tests__/integration/actor-event-relay.integration.test.ts` (`describe.skipIf(!REDIS_URL)`). A stubbed `ConsumerNotificationFeed` returns one `agent_wake` row (createdAt older than the settle lag) with a valid scanner `AgentWakePayload`; a real `ActorEventRelay` + real `InstanceEventPublisher` run one `tick()` against real Redis; the test asserts the stream holds an `agent.wake` envelope with the wake nested under `payload`, then feeds that envelope through `bufferWakeEnvelope` → `drainNewestWakeIntoMarketWake` (source scanner), `applyRuntimeMessage` (currentMarketWake.source scanner), and `buildTickGateState` (hasWakeSignal true). A second `tick()` publishes nothing. `afterAll` deletes the test stream + the relay cursor/lease keys. The composition state is built with a minimal `{ agentId }` descriptor cast — `applyRuntimeMessage`'s agent.wake branch only touches `state.metrics`, which the factory fully initialises.

Gate C evidence:
- Throwaway `redis:7` on :6399 (never the traderton Redis).
- `REDIS_URL="redis://localhost:6399" pnpm exec vitest run apps/worker/src/__tests__/integration/actor-event-relay.integration.test.ts` → 1 passed.
- Without `REDIS_URL`: 1 skipped (confirmed the gate).
- `pnpm exec tsc --build` → 0 errors.
- Commit `76f06b01`.
- Follow-up recorded (plan Follow-ups #4): full cross-stack CI leg (real traderton scan → outbox → relay).

### 2026-10-05 — PART V (herobids) + final verification

V1.1: extracted the saga construction (boundary client + L1 hook) from `apps/api/src/index.ts` into `apps/api/src/agents/create-trading-profile-saga.ts` (`createTradingProfileSaga` → `{ client, saga, timeoutMs }`); `index.ts` now calls it and keeps its own `tradingBackendClient`/`tradingBackendTimeoutMs` for the routes (unchanged). Removed the now-unused `TradingProfileReconciliationSaga`/`createAgentActorLifecycleHook`/`TradingProfileReconciliationOutboxRepository` imports from `index.ts`.

V1.2: `apps/api/src/bin/backfill-profile-scan-config.ts` — `backfillProfileScanConfig` core (unit-testable) + a `main()` guarded to run only when executed directly. For each agent with ≥1 active trading connection it reads the current profiles, proposes with the derived scan config, and (with `--apply`) runs `executeStaged` with `localMutationId backfill-scan-config:<agentId>:<uuid>`; dry-run prints the plan. One line per agent (`sent|unchanged|failed <code>`); continues after a failure; exits non-zero if any failed.

V1.3: `backfill-profile-scan-config.test.ts` (5) — dry-run makes no boundary call; apply sends for a profile lacking scan config; an already-matching profile is unchanged (remote scan config computed via `deriveProfileScanConfig` so it compares equal); one failure does not stop the rest; no-connection agents skipped.

V1.4 + V2 (live) — DEFERRED and recorded: no cross-stack is running (`docker ps` empty) and bringing herobids api/worker + the traderton xstack up non-destructively needs `.env.ops.dev` operator credentials + HMAC secrets. Per the plan's "if the live stacks are not running or not reachable … skip the live checks, record it, and rely on the automated gates" fallback, the backfill `--apply` run and the V2 live DB/Redis/agent-log checks were not performed. The traderton xstack boundary deploy (deferred from Gate T) is likewise not performed. All behaviour is covered by the automated gates below.

Final verification:
- herobids: `pnpm lint` → ok; `pnpm build` → Done; `pnpm test` → 6834 passed, 332 skipped, 0 failed; Part C `REDIS_URL=redis://localhost:6399 pnpm exec vitest run apps/worker/src/__tests__/integration/actor-event-relay.integration.test.ts` → 1 passed (throwaway redis:7).
- traderton: `pnpm lint` → ok; focused `pnpm exec vitest run packages/worker/src/tools/trading-profiles.test.ts packages/worker/src/tools/agent-lifecycle.test.ts` → 28 passed; `pnpm test:integration` → 58 passed, 1 skipped.
- Commit `f3d1879e`.

Branches (never merged, never pushed): herobids `feat/e1h-e3h-agent-wake` (T0 d08ab623 → commits bf06eed7, 94c49d6a, 150ec905, 02def8d9, 76f06b01, f3d1879e, 1b3d1915, cb0e7766); traderton `feat/e1h-e3h-agent-wake` (T0 4a25832 → commit 7392ae7).

### 2026-10-05 — post-implementation review rework

A full-change review (both repos) found no HIGH issues and two MEDIUM, both addressed in `cb0e7766`:
- The API `agent-actor-lifecycle-hook` stop-after-clear branch lacked a D7-style guard (the worker path has one keyed on stoppedSessionId). Added a `getCurrentSession` check so a profile clear racing a fresh session start cannot evict the new actor; +1 test ("does not stop the actor after a clear when a session is live").
- `ActorEventRelay` used `setInterval` + a reentrancy guard rather than the plan/AGENTS.md self-rescheduling `setTimeout`-in-`finally` loop. Switched to reschedule-in-finally with a `stopped` flag.
Plus a LOW doc note: the backfill CLI reuses the full saga (incl. the lifecycle hook) by design.
Re-verified: `pnpm exec tsc --build` clean, `pnpm test` 6835 passed / 332 skipped / 0 failed, Part C integration 1 passed. Remaining findings are LOW only.

Open follow-ups (also in the Follow-ups section): D10 missed-stop reconciliation; traderton consumer-only actor-type fence for scan_consumer_notifications + lifecycle tools; preset identity on swap venues (D3); full cross-stack CI leg for Part C; the deferred live verification (V1.4/V2) + traderton xstack boundary deploy.

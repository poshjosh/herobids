# Plan: Fix Bot Lifecycle — Timestamps, DB State, UI Controls & Verification

**Status:** draft  
**Created:** 2026-06-27  
**Feature ID:** 001-fix-bot-lifecycle

## Problem

Multiple bugs and gaps in the bot lifecycle system:

1. **Inverted lifecycle timestamps** — `started_at > stopped_at` when a bot is stopped then restarted, because `markBotRunning` does not clear the old `stoppedAt` value.
2. **DB state stale after stop** — the `WorkerRuntime.onStopped` callback never persists `status='stopped'` or `stoppedAt`, so bots stopped via BullMQ jobs or worker shutdown remain `status='running'` in the DB indefinitely.
3. **No bot management UI** — users have no way to stop, start, or delete bots from the web UI. The API lacks `DELETE /bots/:id`, `POST /bots/:id/stop`, and `POST /bots/:id/start`.
4. **No bot verification testing** — the agent trade test (`scripts/shell/tests/agent-trade-test.sh`) validates agent trading but there is no equivalent for bot lifecycle correctness (agent-created or user-created).

## Scope

Fix all four areas: DB timestamp correctness, runtime- DB consistency on stop, API + UI lifecycle controls, and automated verification.

Out of scope:
- Bulk actions (stop all, delete all)
- Bot list inline actions (fast-follow)
- Agent runtime session lifecycle changes (agent-scoped, not bot-scoped)
- Bot config schema changes beyond what the lifecycle endpoints need

---

## Implementation Plan

### Phase 1: Fix DB Timestamp Invariants

Two root-cause fixes.

#### 1a. `markBotRunning` must clear `stoppedAt`

**File:** `packages/db/src/repositories.ts`

When a bot transitions from stopped → running, any prior `stoppedAt` must be nulled out. Without this, a restarted bot shows `startedAt > stoppedAt` (new start, old stop).

```ts
// BEFORE
async markBotRunning(botId: string): Promise<void> {
    await this.db
      .update(bots)
      .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
      .where(eq(bots.id, botId));
  }

// AFTER — add stoppedAt: null
async markBotRunning(botId: string): Promise<void> {
    await this.db
      .update(bots)
      .set({ status: 'running', startedAt: new Date(), stoppedAt: null, updatedAt: new Date() })
      .where(eq(bots.id, botId));
  }
```

#### 1b. `onStopped` must persist `status='stopped'` + `stoppedAt` to DB

**File:** `apps/worker/src/index.ts`

The `onStopped` callback in `WorkerRuntimeConfig` only does in-memory cleanup and WebSocket publishing. It must also call `botRepo.markBotStopped()` to persist the stopped state. The `botRepo` is already instantiated at line ~654.

```ts
// BEFORE — onStopped (line ~849)
onStopped: async (instanceId: string) => {
      actorRegistry.delete(instanceId);
      agentStreamConsumer.unsubscribe(instanceId);
      // ... publish events, clean up maps ...
    },

// AFTER — persist DB state FIRST, then clean up
onStopped: async (instanceId: string) => {
      await botRepo.markBotStopped(instanceId);
      actorRegistry.delete(instanceId);
      agentStreamConsumer.unsubscribe(instanceId);
      // ... publish events, clean up maps ...
    },
```

**Invariant table after fixes:**

| Transition | `status` | `startedAt` | `stoppedAt` |
|---|---|---|---|
| Create | `stopped` | `null` | `null` |
| Start | `running` | set to now | `null` |
| Stop | `stopped` | unchanged | set to now |
| Restart | `running` | set to now | `null` |
| Crash | `crashed` | unchanged | set to now |

---

### Phase 2: API Endpoints — Bot Lifecycle Controls

**File:** `apps/api/src/routes/bots.ts`

Three new endpoints. All enforce user ownership (`userId` match on the bot row). See existing `POST /bots` and `PATCH /bots/:id/config` for RBAC patterns.

#### 2a. `DELETE /bots/:id`

- Validate bot exists and belongs to requesting user
- If bot `status === 'running'`, reject with `409 Conflict` — must stop first
- Delete the bot row from `bots` table
- Return `204 No Content`

#### 2b. `POST /bots/:id/stop`

- Validate bot exists and belongs to requesting user
- If bot `status === 'stopped'`, return `200` with `{ status: 'already_stopped', botId }` (idempotent)
- Enqueue `stop-instance` job on the lifecycle BullMQ queue: `{ command: 'stop', botId }`
- Return `202 Accepted` with `{ status: 'stopping', botId }`

#### 2c. `POST /bots/:id/start`

- Validate bot exists and belongs to requesting user
- If bot `status === 'running'`, return `200` with `{ status: 'already_running', botId }` (idempotent)
- Validate execution capability via `validateExecutionCapability` (reuse logic from `PATCH /bots/:id/config`)
- If execution mode is `live`, run `checkLiveEnabled` against the user's plan
- Resolve `tradingBindingId` and `venueAccountId` from the bot row
- Enqueue `start-instance` job on the lifecycle BullMQ queue: `{ command: 'start', botId, config: { ...config, tradingBindingId, userId } }`
- Return `202 Accepted` with `{ status: 'starting', botId }`

**Dependency:** The BullMQ `queue` is already imported and available in the bots route scope (used by `PATCH /bots/:id/config` for restart).

---

### Phase 3: Web API Client

**File:** `apps/web/src/lib/api-client.ts`

Add three methods to the existing `bots` object:

```ts
stop: (id: string) =>
  request<{ status: string; botId: string }>(`/bots/${id}/stop`, { method: 'POST' }),
start: (id: string) =>
  request<{ status: string; botId: string }>(`/bots/${id}/start`, { method: 'POST' }),
delete: (id: string) =>
  request<void>(`/bots/${id}`, { method: 'DELETE' }),
```

---

### Phase 4: UI — Bot Detail Page Action Buttons

**File:** `apps/web/src/features/instances/detail/InstanceDetailPage.tsx`

Add **Stop**, **Start**, and **Delete** action buttons to the page header's `action` slot.

#### Button visibility rules

| Bot status | Stop | Start | Delete |
|---|---|---|---|
| `running` | ✅ | — | — |
| `stopped` | — | ✅ | ✅ |
| `crashed` | — | ✅ | ✅ |
| `starting` | ✅ | — | — |

#### Interaction design

- **Stop** and **Delete** require a confirmation modal (reuse existing `Modal` component from `lib/ui.ts`).
- **Delete** shows an additional warning if the bot has open positions (use existing `positionsQuery.data`).
- **Start** fires immediately — no confirmation needed.
- All buttons show a loading spinner and are disabled while the mutation is in-flight.
- On success:
  - Invalidate `['bots']` and `['bots', id]` query keys.
  - Show brief success feedback.
  - After **Delete**: navigate to `/bots`.
- On error: show the error via existing `ErrorBanner` pattern.
- Idempotent responses (`already_running`, `already_stopped`) are treated as success.

#### Component additions

- `useMutation` hooks (from `@tanstack/react-query`) for each action.
- Confirmation modal state: `showStopConfirm`, `showDeleteConfirm`.
- Position-warning copy in the delete confirmation modal.

---

### Phase 5: Unit Tests

#### 5a. BotRepository timestamp invariant tests

**New file:** `packages/db/src/__tests__/bot-lifecycle.test.ts`

- `markBotRunning clears stoppedAt` — create a row with `stoppedAt` set, call `markBotRunning`, verify `stoppedAt` is `null` and `startedAt` is set
- `markBotStopped sets stoppedAt` — create a row with `status='running'`, call `markBotStopped`, verify `status='stopped'` and `stoppedAt` is set
- `markBotCrashed sets stoppedAt` — same pattern for crash path
- `restoreBotRuntimeState restores old values` — verify the rollback helper works correctly

#### 5b. API endpoint tests

**New file:** `apps/api/src/__tests__/functional/bots-lifecycle.test.ts`

All tests follow existing functional test patterns (see `apps/api/src/__tests__/functional/helpers.ts` for the test app factory).

- `DELETE /bots/:id` — deletes stopped bot, returns 204
- `DELETE /bots/:id` — rejects running bot, returns 409
- `DELETE /bots/:id` — rejects non-owned bot, returns 404
- `POST /bots/:id/stop` — enqueues stop job, returns 202
- `POST /bots/:id/stop` — idempotent on already-stopped bot, returns 200
- `POST /bots/:id/start` — enqueues start job, returns 202
- `POST /bots/:id/start` — idempotent on already-running bot, returns 200
- `POST /bots/:id/start` — rejects live mode when plan lacks `liveEnabled`, returns 403
- `POST /bots/:id/start` — rejects invalid execution capability (paper+swap), returns 400
- `POST /bots/:id/start` — rejects non-owned bot, returns 404

#### 5c. UI interaction tests

**File:** `apps/web/src/features/instances/detail/InstanceDetailPage.test.tsx` (new or extend existing)

- Bot detail page renders Stop button when status is `running`
- Bot detail page renders Start + Delete buttons when status is `stopped`
- Bot detail page renders Start + Delete buttons when status is `crashed`
- Stop button triggers confirmation modal, confirms, then calls `bots.stop()` API
- Delete button triggers confirmation modal, confirms, navigates to `/bots` on success
- Delete button shows position count warning when open positions exist
- Start button fires immediately with no confirmation
- Mutation loading state disables the clicked button and shows spinner
- API error is displayed via ErrorBanner

---

### Phase 6: E2E Bot Trade Test

Pattern after `scripts/ts/agent-trade-test.ts` and `scripts/shell/tests/agent-trade-test.sh`.

#### 6a. TypeScript test script

**New file:** `scripts/ts/bot-trade-test.ts`

Phases:

1. **Stack health** — verify API is reachable; optionally start Docker Compose
2. **Setup** — register/login, create provider-link, create a trading binding, create a bot via `POST /bots`
3. **User-created bot lifecycle** —
   - Start bot via `POST /bots/:id/start` → verify `202`, poll until `status='running'`
   - Verify invariants: `startedAt` set, `stoppedAt === null`, `startedAt > createdAt`
   - Wait for trading activity (fills via `GET /bots/:id/events`)
   - Stop bot via `POST /bots/:id/stop` → verify `202`, poll until `status='stopped'`
   - Verify invariants: `stoppedAt` set, `stoppedAt > startedAt`, `status='stopped'`
   - Restart bot via `POST /bots/:id/start` → verify `202`, poll until `status='running'`
   - Verify invariants: `stoppedAt === null` (Phase 1 fix validated), `startedAt` set to new value
4. **Idempotency checks** —
   - Double-start → `200 already_running`
   - Double-stop → `200 already_stopped`
5. **Guard checks** —
   - Delete while running → `409 Conflict`
   - Stop the bot, then delete → `204 No Content`
6. **Agent-created bot lifecycle** —
   - Create an agent with a prompt that instructs it to: create a bot, start it, wait one tick, stop it
   - Poll the agent's managed bots via `GET /agents/:id` → verify bot transitions
   - Verify the bot's DB invariants match the user-created path
7. **Teardown** — stop/delete agent, delete test user's remaining bots, optionally stop Docker

#### 6b. Shell wrapper

**New file:** `scripts/shell/tests/bot-trade-test.sh`

Same pattern as `agent-trade-test.sh`:
- Load credentials from `scripts/.env.trade-test`
- Validate required env vars (API_BASE_URL, TEST_EMAIL, TEST_PASSWORD, venue secrets)
- Support `--env`, `--dry-run`, `--help` flags
- Run the TypeScript test via `tsx`

#### 6c. Env vars required

| Variable | Default | Notes |
|---|---|---|
| `API_BASE_URL` | `http://localhost:3000` | |
| `TEST_EMAIL` | `trade-test@local.test` | |
| `TEST_PASSWORD` | `TradeTest123!` | |
| `VENUE` | `hyperliquid` | hyperliquid / bybit / 1inch |
| `EXECUTION_MODE` | `paper` | paper / shadow / live |
| `HL_API_KEY` | — | Required for hyperliquid |
| `HL_SECRET` | — | Required for hyperliquid |
| `HL_WALLET_ADDRESS` | — | Required for hyperliquid |
| `TICK_INTERVAL_MS` | `60000` | |
| `TIMEOUT_MS` | `600000` | |
| `DOCKER_COMPOSE_UP` | `0` | |
| `DOCKER_COMPOSE_DOWN` | `0` | |
| `SKIP_TEARDOWN` | `0` | |

---

### Phase 7: Bug Reports

File two dated bug reports in `docs/bug-reports/2026/06/27/`.

#### 7a. `001-bot-startedAt-after-stoppedAt.md`

- **Severity:** High
- **Summary:** `markBotRunning` does not clear `stoppedAt`, causing inverted lifecycle timestamps when a bot is restarted
- **Root Cause:** `packages/db/src/repositories.ts` — `markBotRunning` only sets `status`, `startedAt`, and `updatedAt`; never nulls out `stoppedAt`
- **Fix:** Add `stoppedAt: null` to the `.set()` call in `markBotRunning`

#### 7b. `002-onStopped-does-not-persist-db.md`

- **Severity:** High
- **Summary:** Worker's `onStopped` callback never updates the bot's DB row, so bots stopped via BullMQ or worker shutdown remain `status='running'` in the database
- **Root Cause:** `apps/worker/src/index.ts` — `onStopped` callback only does in-memory cleanup; never calls `botRepo.markBotStopped()`
- **Fix:** Call `await botRepo.markBotStopped(instanceId)` at the top of `onStopped`

---

## Files Changed

| File | Change |
|---|---|
| `packages/db/src/repositories.ts` | `markBotRunning`: add `stoppedAt: null` to `.set()` |
| `apps/worker/src/index.ts` | `onStopped` callback: add `await botRepo.markBotStopped(instanceId)` |
| `apps/api/src/routes/bots.ts` | Add `DELETE /bots/:id`, `POST /bots/:id/stop`, `POST /bots/:id/start` |
| `apps/web/src/lib/api-client.ts` | Add `bots.stop()`, `bots.start()`, `bots.delete()` |
| `apps/web/src/features/instances/detail/InstanceDetailPage.tsx` | Add Stop/Start/Delete action buttons with confirmation modals |
| `packages/db/src/__tests__/bot-lifecycle.test.ts` | **New** — timestamp invariant unit tests |
| `apps/api/src/__tests__/functional/bots-lifecycle.test.ts` | **New** — API endpoint functional tests |
| `apps/web/src/features/instances/detail/InstanceDetailPage.test.tsx` | **New/updated** — UI interaction tests |
| `scripts/ts/bot-trade-test.ts` | **New** — E2E bot lifecycle verification |
| `scripts/shell/tests/bot-trade-test.sh` | **New** — Shell wrapper for bot trade test |
| `docs/bug-reports/2026/06/27/001-bot-startedAt-after-stoppedAt.md` | **New** — Bug report |
| `docs/bug-reports/2026/06/27/002-onStopped-does-not-persist-db.md` | **New** — Bug report |

---

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| `onStopped` DB write fails (e.g. DB down) | MEDIUM | Catch and log — the in-memory cleanup still runs. The reclaim sweep will detect the orphaned actor. A subsequent start will clear stale state. |
| `markBotRunning` clearing `stoppedAt` loses forensic data | LOW | `stoppedAt` on a running bot is always a bug. Journal events (`instance.started`/`instance.stopped`) provide the full audit trail independent of the `bots` row. |
| Stop while bot has open positions | MEDIUM | Stop only stops the scan loop; positions remain in DB. Reconciliation sweep continues to reconcile them. Document this behavior in the stop confirmation modal. |
| Delete while bot has open positions | HIGH | Block delete if `status === 'running'` (409). If `status === 'stopped'` with open positions, show a warning in the confirmation modal — user must explicitly confirm. |
| Race: user clicks start + agent clicks stop | LOW | Last-write-wins; both go through BullMQ. The worker's idempotency handling (`startingInstances` + `pendingStops`) resolves the race. |
| Live-mode start without credentials | LOW | Existing `assertLiveReadiness` gate in the worker rejects at startup. Error propagates to `onStartFailed` → `status='crashed'`. |

---

## Acceptance Criteria

1. **AC1** — After starting a previously-stopped bot, `stoppedAt` is `null` and `startedAt > stoppedAt` is never true
2. **AC2** — After stopping a running bot (via API, agent tool, or worker shutdown), DB shows `status='stopped'` with `stoppedAt` set
3. **AC3** — User can stop a running bot from the bot detail page
4. **AC4** — User can start a stopped/crashed bot from the bot detail page
5. **AC5** — User can delete a stopped bot from the bot detail page
6. **AC6** — User cannot delete a running bot (must stop first — 409 Conflict)
7. **AC7** — User cannot start a bot in live mode if their plan does not allow it
8. **AC8** — All action buttons show loading state and handle API errors gracefully
9. **AC9** — Deleting a bot navigates back to the bot list
10. **AC10** — All new API endpoints enforce user ownership (cannot act on another user's bot)
11. **AC11** — Bot trade test passes end-to-end: create → start → verify trading → stop → verify invariants → restart → verify invariants → delete
12. **AC12** — `pnpm lint` passes
13. **AC13** — All new and existing tests pass (`pnpm test`)

---

## Verification

Run after all phases complete:

```bash
pnpm lint                          # TypeScript strict check
pnpm test                          # All unit + functional + UI tests
pnpm --filter @herobids/db test    # Bot lifecycle timestamp invariant tests
pnpm --filter @herobids/api test   # API endpoint functional tests
pnpm --filter @herobids/web test   # UI interaction tests
```

Manual verification:

```bash
# Full bot trade test (requires running stack)
scripts/shell/tests/bot-trade-test.sh

# Quick run with overrides
HL_API_KEY=... HL_SECRET=... HL_WALLET_ADDRESS=0x... \
  VENUE=hyperliquid EXECUTION_MODE=paper \
  scripts/shell/tests/bot-trade-test.sh
```

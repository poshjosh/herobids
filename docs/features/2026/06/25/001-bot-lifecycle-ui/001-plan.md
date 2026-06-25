# Plan: Bot Lifecycle Controls in UI

**Status:** draft  
**Created:** 2026-06-25  
**Feature ID:** 001-bot-lifecycle-ui

## Problem

Users cannot stop, start, or delete bots from the UI. The API exposes `PATCH /bots/:id/config` and the worker has BullMQ lifecycle job handlers (`stop-instance`, `start-instance`, `restart-instance`), but no REST endpoints exist for lifecycle actions and no UI controls surface them. This is a critical gap — an agent creating a rogue live bot leaves the user with no UI kill switch.

## Scope

Add **Stop**, **Start**, and **Delete** actions for bots, accessible from the bot detail page (`/bots/:id`).

Out of scope:
- Bulk actions (stop all, delete all)
- Bot list inline actions (can follow as a fast-follow)
- Restart (covered by config update + running check in the existing `PATCH /bots/:id/config`)

## Implementation Plan

### Phase 1: API Endpoints (`apps/api/src/routes/bots.ts`)

Three new endpoints. All enforce user ownership (`userId` match on the bot row).

#### 1a. `DELETE /bots/:id`

- Validate bot exists and belongs to user
- If bot is `running`, reject (must stop first) — return `409 Conflict`
- Delete the bot row
- Return `204 No Content`

#### 1b. `POST /bots/:id/stop`

- Validate bot exists and belongs to user
- If bot is already `stopped`, return `200` with `{ status: 'already_stopped' }`
- Enqueue `stop-instance` job on the lifecycle BullMQ queue
- Return `202 Accepted` with `{ status: 'stopping', botId }`

#### 1c. `POST /bots/:id/start`

- Validate bot exists and belongs to user
- If bot is already `running`, return `200` with `{ status: 'already_running' }`
- Validate execution capability (existing logic from `PATCH /bots/:id/config`)
- If execution mode is `live`, run plan-level `checkLiveEnabled`
- Resolve `tradingBindingId` and `venueAccountId` from the bot row
- Enqueue `start-instance` job on the lifecycle BullMQ queue (mirrors the `create_and_start` path in the worker)
- Return `202 Accepted` with `{ status: 'starting', botId }`

**Dependency:** The API route file needs access to the BullMQ `queue`. Verify `queue` is already imported and available in the bots route scope (it is — used by `PATCH /bots/:id/config` for restart).

### Phase 2: Web API Client (`apps/web/src/lib/api-client.ts`)

Add three methods to the `bots` object:

```ts
stop: (id: string) => request<{ status: string; botId: string }>(`/bots/${id}/stop`, { method: 'POST' }),
start: (id: string) => request<{ status: string; botId: string }>(`/bots/${id}/start`, { method: 'POST' }),
delete: (id: string) => request<void>(`/bots/${id}`, { method: 'DELETE' }),
```

### Phase 3: UI — Bot Detail Page (`apps/web/src/features/instances/detail/InstanceDetailPage.tsx`)

Add action buttons in the page header's `action` slot:

```
[← Back]  [Stop]  [Start]  [Delete]
```

Button visibility rules:
| Bot status | Stop | Start | Delete |
|-----------|------|-------|--------|
| `running` | ✅ | — | — |
| `stopped` | — | ✅ | ✅ |
| `crashed` | — | ✅ | ✅ |
| `starting` | ✅ | — | — |

**Stop** and **Delete** require a confirmation modal (`Modal` component already exists in the UI library).

**Delete** shows a warning if the bot has open positions (use existing `positionsQuery` data).

All mutations invalidate `['bots']` and `['bots', id]` query keys on success, and navigate to `/bots` after delete.

**States to handle per button:**

| State | Handling |
|-------|----------|
| Loading | Button shows spinner, disabled |
| Success | Invalidate queries, show brief success feedback |
| Error (API) | Show error via existing `ErrorBanner` pattern |
| Already stopped/started | API returns 200, treat as success |

### Phase 4: Tests

#### API tests (`apps/api/src/__tests__/functional/` or route test file)

- `DELETE /bots/:id` — deletes stopped bot, returns 204
- `DELETE /bots/:id` — rejects running bot, returns 409
- `DELETE /bots/:id` — rejects non-owned bot, returns 404
- `POST /bots/:id/stop` — enqueues stop job, returns 202
- `POST /bots/:id/stop` — idempotent on already-stopped bot, returns 200
- `POST /bots/:id/start` — enqueues start job, returns 202
- `POST /bots/:id/start` — rejects live mode when plan lacks `liveEnabled`, returns 403
- `POST /bots/:id/start` — rejects paper+swap, returns 400

#### UI tests (existing vitest + React Testing Library patterns)

- Bot detail page renders Stop button when status is `running`
- Bot detail page renders Start + Delete buttons when status is `stopped`
- Stop button triggers confirmation modal, then calls API
- Delete button triggers confirmation modal, navigates away on success
- Delete button shows position warning when open positions exist

## Files Changed

| File | Change |
|------|--------|
| `apps/api/src/routes/bots.ts` | Add `DELETE /bots/:id`, `POST /bots/:id/stop`, `POST /bots/:id/start` |
| `apps/web/src/lib/api-client.ts` | Add `bots.stop()`, `bots.start()`, `bots.delete()` |
| `apps/web/src/features/instances/detail/InstanceDetailPage.tsx` | Add action buttons with confirmation modals |
| `apps/api/src/__tests__/functional/bots-lifecycle.test.ts` | New file — API endpoint tests |
| `apps/web/src/features/instances/detail/InstanceDetailPage.test.tsx` | New or existing — UI interaction tests |

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Stop while bot has open positions | MEDIUM | Stop only stops the actor loop; positions remain in DB. The reconciliation sweep will still reconcile them. Document this behavior. |
| Delete while bot has open positions | HIGH | Block delete if `status === 'running'`. Warn (but allow) if `status === 'stopped'` with open positions — user must explicitly confirm. |
| Race: user clicks start + agent clicks stop | LOW | Last-write-wins is acceptable. Both go through the queue; the worker's idempotency handling resolves it. |
| Live-mode start without credentials | LOW | Existing `assertLiveReadiness` gate in the worker will reject at startup. Return a clear error to the UI. |

## Acceptance Criteria

1. User can stop a running bot from the bot detail page
2. User can start a stopped bot from the bot detail page
3. User can delete a stopped bot from the bot detail page
4. User cannot delete a running bot (must stop first)
5. User cannot start a bot in live mode if their plan does not allow it
6. All actions show loading state and handle API errors gracefully
7. Deleting a bot navigates back to the bot list
8. All new API endpoints enforce user ownership

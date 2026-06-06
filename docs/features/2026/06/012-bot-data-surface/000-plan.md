# 012 — Bot Data Surface

## Status
`todo`

## Goal
Expose per-bot costs, sessions, events, and journal — the data surface users need to understand what their bots are doing and have done.

## Scope

### New API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/bots/:id/costs` | Cost summary for a bot |
| `GET` | `/bots/:id/sessions` | Paginated bot sessions. Query: `limit`, `offset` |
| `GET` | `/bots/:id/events` | Recent activity events. Query: `limit` (max 500) |
| `GET` | `/bots/:id/journal` | Journal entries (paginated). Query: `limit`, `offset`, `type` |
| `GET` | `/bots/:id/journal/summary` | Aggregate journal stats (trade count, win rate, total PnL) |

### UAT shell script

Create `shell/tests/run-uat.sh` with auth + bots + these endpoints as the first milestone UAT target.

## Response shapes

**`/bots/:id/costs`**
```json
{ "botId": "...", "totalCost": "0.00", "byType": { "llm_tokens": "0.00", "infra_time": "0.00" } }
```

**`/bots/:id/sessions`**
```json
{ "sessions": [...], "total": 0 }
```

**`/bots/:id/events`**
```json
{ "events": [{ "id": "...", "type": "...", "message": "...", "createdAt": "..." }] }
```

**`/bots/:id/journal`**
```json
{ "events": [...], "total": 0 }
```

**`/bots/:id/journal/summary`**
```json
{ "tradeCount": 0, "winCount": 0, "totalPnl": "0.00", "winRate": null }
```

## Acceptance criteria

- [ ] All 5 endpoints return 200 for a bot owned by the authenticated user
- [ ] All 5 endpoints return 404 for a bot owned by another user (ownership check)
- [ ] Pagination works correctly on sessions and journal (limit/offset)
- [ ] `shell/tests/run-uat.sh` created and covers auth + bot lifecycle + these endpoints
- [ ] Integration tests in `apps/api/src/routes/bots.test.ts` cover all endpoints
- [ ] `pnpm lint` passes

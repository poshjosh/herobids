# 014 — Billing Ledger + Sessions

## Status
`done`

## Goal
Expose paginated cost records and actor sessions so users can audit spending and review historical bot/agent runs.

## Scope

### New API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/billing/ledger` | Paginated cost records. Query: `limit`, `offset`, `agentId`, `botId`, `sessionId`, `type` (llm_tokens\|infra_time), `from`, `to` |
| `GET` | `/sessions` | Paginated actor sessions. Query: `actorType`, `botId`, `agentId`, `limit`, `offset` |
| `GET` | `/sessions/:id` | Single session detail + associated costs |

## Response shapes

**`/billing/ledger`**
```json
{ "records": [...], "total": 0, "limit": 50, "offset": 0 }
```

**`/sessions`**
```json
{ "sessions": [...], "total": 0 }
```

**`/sessions/:id`**
```json
{ "session": { "id": "...", "actorType": "bot", "actorId": "...", "startedAt": "...", "endedAt": null, "status": "..." }, "costs": {} }
```

## Schema dependency

If a `sessions` / `bot_runs` table does not exist yet, this feature requires a migration to create it. The table should record:
- `id`, `actorType`, `actorId`, `userId`, `startedAt`, `endedAt`, `status`, `blueprintVersion`

Check existing schema in `packages/db/src/` before creating the migration.

## Acceptance criteria

- [ ] `GET /billing/ledger` returns scoped records (only caller's own data)
- [ ] `GET /billing/ledger` supports all documented query filters
- [ ] `GET /sessions` returns scoped sessions with pagination
- [ ] `GET /sessions/:id` returns 404 for sessions owned by another user
- [ ] Integration tests cover all three endpoints including filter combinations
- [ ] `pnpm lint` passes

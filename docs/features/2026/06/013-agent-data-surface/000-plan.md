# 013 — Agent Data Surface

## Status
`todo`

## Goal
Expose per-agent live trading state, managed bots, costs, and journal — the data surface agents need to show users what they own and what they have done.

## Scope

### New API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/agents/:id/state` | Live trading state: PnL, open positions, capital summary |
| `GET` | `/agents/:id/bots` | Bots spawned by this agent (includes status, blueprint ref) |
| `GET` | `/agents/:id/costs` | Cost summary for agent. Query: `from`, `to` |
| `GET` | `/agents/:id/journal` | Agent's journal entries. Query: `limit`, `offset`, `type` |
| `GET` | `/agents/:id/trades` | Agent's direct trades. Query: `limit`, `offset` |

## Response shapes

**`/agents/:id/state`**
```json
{
  "agentId": "...",
  "totalPnl": "0.00",
  "openPositionCount": 0,
  "capitalDeployed": "0.00",
  "capitalAvailable": null,
  "updatedAt": "..."
}
```

**`/agents/:id/bots`**
```json
{ "bots": [{ "id": "...", "status": "...", "blueprintId": null, "createdAt": "..." }] }
```

**`/agents/:id/costs`**
```json
{ "agentId": "...", "totalCost": "0.00", "byType": {} }
```

## Acceptance criteria

- [ ] All 5 endpoints return 200 for an agent owned by the authenticated user
- [ ] All 5 endpoints return 404 for an agent owned by another user
- [ ] `/agents/:id/state` aggregates across all bots owned by the agent
- [ ] `/agents/:id/bots` only returns bots where `creatorType = 'agent'` and `creatorId = agentId`
- [ ] Integration tests in `apps/api/src/routes/agents.test.ts` cover all endpoints
- [ ] `pnpm lint` passes

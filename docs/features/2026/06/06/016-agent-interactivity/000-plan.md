# 016 — Agent Interactivity

## Status
`done`

## Goal
Let users and operators interact with running agents: send messages, inspect memory, view the compiled prompt, and manage Telegram notifications.

## Scope

### New/updated API endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/agents/:id/message` | Send message to running agent. Body: `{ message }`. Rate-limited: 10/min |
| `GET` | `/agents/:id/memory` | Agent memory entries. Query: `prefix`, `limit`, `keysOnly` |
| `GET` | `/agents/:id/prompt` | Last compiled system prompt (in-memory only, not persisted) |
| `GET` | `/agents/:id/trades` | Agent's direct trades. Query: `limit`, `offset` |
| `PUT` | `/agents/:id` | Full update (agent must be stopped). Body: same fields as POST |
| `POST` | `/agents/verify-telegram` | Verify a Telegram chat ID is reachable. Body: `{ chatId }` |
| `GET` | `/agents/telegram-bot` | Get the platform Telegram bot `@username` |
| `POST` | `/telegram/webhook` | Telegram Bot API webhook receiver (unauthenticated, token-validated) |

### Agent export endpoints

| Method | Path |
|---|---|
| `GET` | `/agents/:id/export/trades` |
| `GET` | `/agents/:id/export/journal` |
| `GET` | `/agents/:id/export/costs` |
| `GET` | `/agents/:id/export/sessions` |
| `GET` | `/agents/:id/export/config` |
| `GET` | `/agents/:id/export/bundle` |

## Notes

- `POST /agents/:id/message` delivers to the running agent via the existing Redis stream transport. If agent is stopped, return 409.
- `GET /agents/:id/memory` reads from the agent's in-memory or Redis-backed key-value store. Shape depends on how agent memory is currently implemented in `apps/worker/src/agent.ts`.
- `GET /agents/:id/prompt` is in-memory only — return 404 if agent is not running.
- `PUT /agents/:id` requires agent to be in `stopped` status — return 409 if running.
- Telegram integration requires `TELEGRAM_BOT_TOKEN` in operator config. All three Telegram endpoints are no-ops (return 501) if token is not configured.

## Acceptance criteria

- [ ] `POST /agents/:id/message` delivers to running agent, returns 409 if stopped
- [ ] `POST /agents/:id/message` rate-limited at 10/min per user
- [ ] `GET /agents/:id/memory` returns scoped results with prefix filter
- [ ] `GET /agents/:id/prompt` returns 404 if agent not running
- [ ] `PUT /agents/:id` returns 409 if agent is running
- [ ] All 6 export endpoints return correct file content-type and disposition headers
- [ ] Telegram endpoints return 501 when `TELEGRAM_BOT_TOKEN` not configured
- [ ] Integration tests cover all endpoints
- [ ] `pnpm lint` passes

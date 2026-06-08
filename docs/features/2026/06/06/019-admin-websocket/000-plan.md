# 019 — Admin Endpoints + WebSocket Event Stream

## Status
`todo`

## Goal
Provide operator visibility into system health and enable real-time UI updates via WebSocket.

## Scope

### Admin endpoints (admin role required)

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/stats` | System stats: version, postgres/redis health, server memory, disk, user/bot/agent counts |
| `GET` | `/admin/users` | All users with bot and agent counts |
| `GET` | `/admin/containers` | Running agent containers with CPU/memory stats |

### WebSocket event stream

| Path | Auth | Description |
|---|---|---|
| `GET /events?token=<JWT>` | JWT query param | Real-time event stream for bot and agent events scoped to authenticated user |

#### Event types pushed over WebSocket

- Bot status changes (`running`, `stopped`, `crashed`)
- Agent status changes
- Order filled
- Decision accepted/rejected
- Risk guardrail triggered
- Platform safety alert

#### Connection behavior

- Server sends a ping frame every 30 seconds
- Client disconnect is detected via missed pong (configurable timeout)
- Events are scoped to the authenticated user — no cross-user leakage
- Reconnect: client re-authenticates with a fresh JWT; server does not maintain reconnect state

## Notes

- `/admin/stats` health checks must be non-blocking — use `Promise.race` with a short timeout per service.
- `/admin/containers` requires Docker socket access. Return `{ error: 'docker_unavailable' }` if socket is not accessible rather than 500.
- WebSocket events are published by the worker via Redis pub/sub (low-value, non-durable). The API server subscribes and fans out to connected clients. This is explicitly not the canonical agent protocol path (which uses Redis Streams) — see ADR 002.
- The JWT must be validated on the WebSocket upgrade request, not just at connection time.

## Acceptance criteria

- [ ] `/admin/stats` returns 403 for non-admin users
- [ ] `/admin/stats` postgres/redis health checks complete in < 2 seconds
- [ ] `/admin/containers` returns `docker_unavailable` when Docker socket is absent (not 500)
- [ ] WebSocket connection rejects invalid/expired JWT with close code 4001
- [ ] WebSocket events are scoped: user A cannot receive user B's events
- [ ] Server sends ping every 30 seconds on idle connections
- [ ] Integration tests cover admin auth enforcement and WebSocket auth rejection
- [ ] `pnpm lint` passes

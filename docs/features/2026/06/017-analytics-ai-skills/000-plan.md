# 017 — Analytics, AI Endpoints, and Skills

## Status
`done`

## Goal
Cross-bot/agent analytics, AI-powered config generation and portfolio analysis, and user-managed skills.

## Scope

### Analytics

| Method | Path | Description |
|---|---|---|
| `GET` | `/analytics` | Query analytics via URL params. Filters: `from`, `to`, `botIds`, `agentIds`, `decisionModes`, `sessions`, `groupBy` (day\|week\|session\|strategy) |
| `POST` | `/analytics/query` | Same as GET but via JSON body (for complex queries) |

Analytics aggregates from `journal_events` and `positions`. No separate analytics table for v1 — compute on read with appropriate indexes.

### AI endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/ai/available-models` | List configured AI providers and curated model lists |
| `POST` | `/ai/generate-config` | Generate blueprint config from freeform text. Body: `{ text }`. Rate-limited: 10/min |
| `POST` | `/ai/analyze-portfolio` | AI portfolio analysis. Body: `{ openPositions, closedPositions, totalPnl, tradeCount }` |
| `POST` | `/ai/explain-signal` | AI explanation of a trade signal. Body: `{ signal, candles? }` |
| `PATCH` | `/settings/ai-model` | Set AI model preference chain. Body: `{ primary, fallback1, fallback2 }` each `{ provider, model }` or `null` |

### Skills

| Method | Path | Description |
|---|---|---|
| `GET` | `/skills` | List skills (own + public + built-in) |
| `POST` | `/skills` | Create skill |
| `GET` | `/skills/:id` | Get skill |
| `PUT` | `/skills/:id` | Update own skill |
| `DELETE` | `/skills/:id` | Delete own skill |
| `POST` | `/skills/:id/fork` | Fork a public/built-in skill |

### Datasets

| Method | Path | Description |
|---|---|---|
| `GET` | `/datasets` | List available datasets |
| `GET` | `/datasets/:id` | Dataset detail |
| `POST` | `/datasets/fetch` | Fetch OHLCV data. Rate-limited: 1/min |
| `POST` | `/datasets/upload` | Upload CSV. Rate-limited: 1/30s. (v1: CSV body only; ZIP not yet supported) |

## Notes

- AI endpoints require at least one LLM provider key configured. All AI endpoints return 503 with `{ error: 'no_ai_provider' }` when none is configured.
- `/ai/available-models` lists only providers with active API keys — do not leak unconfigured provider names.
- Skills schema: `id`, `authorId` (null for built-in/system skills), `name`, `instructions`, `description`, `visibility` (`private` | `public` | `built-in`), `requiredTools`, `tags`, `createdAt`, `updatedAt`. The field is named `authorId` in the DB schema (not `userId`) to distinguish skill authorship from general user ownership. System/built-in skills have `authorId = null`; user-created skills carry the owner's `userId`. The `visibility` field on user-created skills accepts `private` or `public` only — `built-in` is reserved for system-seeded rows.
- Datasets storage: store metadata in Postgres, large bodies on disk or object storage. v1 can use local filesystem.

## Acceptance criteria

- [ ] `GET /analytics` and `POST /analytics/query` return correct aggregations
- [ ] Analytics is scoped to the authenticated user's bots/agents only
- [ ] All 4 AI endpoints return 503 when no provider is configured
- [ ] `GET /ai/available-models` never reveals unconfigured providers
- [ ] `POST /ai/generate-config` returns a valid blueprint `configData` object
- [ ] All 6 skills endpoints work with correct visibility scoping
- [ ] `POST /skills/:id/fork` creates a `private` copy owned by the caller
- [ ] Integration tests cover all endpoints (AI tests can use mock LLM responses)
- [ ] `pnpm lint` passes

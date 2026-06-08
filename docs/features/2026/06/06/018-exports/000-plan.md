# 018 — Bot + Account Exports

## Status
`todo`

## Goal
Let users download their trading data in standard formats (CSV, JSON, Markdown, YAML, ZIP bundle) at the bot level and account level.

## Scope

### Bot-level exports

| Method | Path | Query |
|---|---|---|
| `GET` | `/bots/:id/export/trades` | `format` (csv\|json), `from`, `to`, `tz` |
| `GET` | `/bots/:id/export/journal` | `format` (md\|json), `from`, `to` |
| `GET` | `/bots/:id/export/config` | `format` (yaml\|json) |
| `GET` | `/bots/:id/export/report` | `format` (json\|csv) |
| `GET` | `/bots/:id/export/bundle` | ZIP of trades.csv + journal.md + config.yaml + report.json |

### Account-level exports

| Method | Path | Query |
|---|---|---|
| `GET` | `/export/trades` | `format` (csv\|json), `from`, `to`, `tz` |
| `GET` | `/export/bundle` | ZIP of all user data |

### Agent-level exports (if not covered by 016)

| Method | Path |
|---|---|
| `GET` | `/agents/:id/export/trades` |
| `GET` | `/agents/:id/export/journal` |
| `GET` | `/agents/:id/export/costs` |
| `GET` | `/agents/:id/export/sessions` |
| `GET` | `/agents/:id/export/config` |
| `GET` | `/agents/:id/export/bundle` |

## Notes

- All export routes are rate-limited: 5 requests/min per user.
- Config exports must never include decrypted secrets, private keys, or API tokens.
- Trades CSV headers: `date, side, symbol, quantity, price, pnl, fee, sessionId`.
- Report JSON includes: `winRate`, `totalPnl`, `tradeCount`, `sharpeRatio` (null if insufficient data).
- ZIP bundle built in-memory — do not write temp files to disk unless necessary.
- For bots with zero trades, exports return empty file with headers (CSV) or empty array (JSON) — not 404.

## Acceptance criteria

- [ ] All bot export endpoints return correct `Content-Type` and `Content-Disposition` headers
- [ ] Config export contains no sensitive fields
- [ ] Date range filter correctly bounds exported data
- [ ] Zero-trade bot returns valid empty export (not 404)
- [ ] Rate limit: 6th request within 1 minute returns 429 with `Retry-After` header
- [ ] ZIP bundle contains all expected files
- [ ] Integration tests cover all endpoints
- [ ] `pnpm lint` passes

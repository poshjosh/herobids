# Issues — Migration (herobids → traderton boundary) 2026-09-23

Triage of anomalies observed in the 2026-09-23 agent evaluation (see
`.ignore/eval/2026/09/23/REPORT.md`) that trace to the trading-extraction to the
Traderton boundary. Grouped where the fixes belong together.

Status legend: OPEN = not yet fixed · FIXED = fixed · CLOSED = verified/closed.

| # | Title | Severity | Status | Link |
|---|-------|----------|--------|------|
| 001 | `check_watches` boundary poll storm + `removeTriggered` schema coercion | Medium | FIXED | [001-check-watches-boundary-poll-storm-coercion.md](./001-check-watches-boundary-poll-storm-coercion.md) |
| 002 | `decision_contexts.actor_id` written NULL (actor identity dropped) | Low | CLOSED (not migration-caused) | [002-decision-contexts-actor-id-null.md](./002-decision-contexts-actor-id-null.md) |
| 003 | Market-data discovery provider rejections (geckoterminal 429 / coinmarketcap 403) | Low | CLOSED (not migration-caused) | [003-market-data-discovery-rate-limit-noise.md](./003-market-data-discovery-rate-limit-noise.md) |

**Issue 001 deliberately groups two `check_watches` findings** — the poll storm
(B3 monitor calling the boundary per-agent every 5s) and the `removeTriggered`
string/boolean coercion failure — because both live in the `check_watches` path
introduced by the migration and their fixes touch adjacent files in one
coherent change-set.

Non-migration-related anomalies from the report are **not** tracked here:
`thyper` scanner-gated dormancy, the inert preset-review loop, the Docker
event-stream timeouts, and the `pa` browser loop are pre-existing / by-design /
infra, not boundary regressions.
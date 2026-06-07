# Feature Roadmap — 2026 Q2/Q3

**Goal:** Reach feature parity with aitradingbot while preserving herobids architecture principles.

**Methodology:** stub-first + integration tests. Each feature is scaffolded as 501 stubs with failing integration tests before any implementation begins. A feature is done when its integration tests pass and the UAT script covers it.

---

## Backlog — ordered by dependency

| # | Feature | Priority | Status | Spec |
|---|---|---|---|---|
| 010 | Rename `tradingInstanceId` → `botId` | P0 | done | [010-rename-tradinginstanceid/000-plan.md](010-rename-tradinginstanceid/000-plan.md) |
| 011 | Plan quota TOCTOU fix | P0 | done | [011-plan-quota-fix/000-plan.md](011-plan-quota-fix/000-plan.md) |
| 012 | Bot data surface (costs, sessions, events, journal) | P0 | done | [012-bot-data-surface/000-plan.md](012-bot-data-surface/000-plan.md) |
| 013 | Agent data surface (state, bots, costs, journal) | P0 | done | [013-agent-data-surface/000-plan.md](013-agent-data-surface/000-plan.md) |
| 014 | Billing ledger + sessions | P0 | done | [014-billing-ledger-sessions/000-plan.md](014-billing-ledger-sessions/000-plan.md) |
| 015 | Blueprints system | P1 | done | [015-blueprints/000-plan.md](015-blueprints/000-plan.md) |
| 016 | Agent interactivity (message, memory, prompt) | P2 | done | [016-agent-interactivity/000-plan.md](016-agent-interactivity/000-plan.md) |
| 017 | Analytics + AI endpoints + Skills | P3 | done | [017-analytics-ai-skills/000-plan.md](017-analytics-ai-skills/000-plan.md) |
| 018 | Bot + account exports | P3 | todo | [018-exports/000-plan.md](018-exports/000-plan.md) |
| 019 | Admin + WebSocket event stream | P4 | todo | [019-admin-websocket/000-plan.md](019-admin-websocket/000-plan.md) |
| 020 | Frontend completeness | P4 | todo | [020-frontend/000-plan.md](020-frontend/000-plan.md) |

---

## Status key

| Tag | Meaning |
|---|---|
| `todo` | Not started |
| `stub` | 501 stubs and failing integration tests written |
| `in-progress` | Implementation underway |
| `done` | Integration tests pass, UAT covers it |
| `blocked` | Waiting on a dependency |

---

## Done signal

A feature moves to `done` when:

1. All integration tests in `apps/api/src/routes/*.test.ts` or `apps/api/src/__tests__/functional/` pass
2. The `shell/tests/run-uat.sh` script passes for all cases in that feature's scope
3. `pnpm lint` passes

Not when: the checklist is ticked, or the code looks right on inspection.

---

## Test infrastructure

- **Unit/integration:** `apps/api/src/routes/*.test.ts` and `apps/api/src/__tests__/functional/*.test.ts`
- **UAT shell script:** `shell/tests/run-uat.sh` (to be created as part of feature 012 milestone)
- **Vitest config:** `vitest.config.ts` (workspace root)

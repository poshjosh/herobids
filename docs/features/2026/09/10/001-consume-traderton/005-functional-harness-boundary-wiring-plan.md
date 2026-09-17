# 005 — Fix functional test harness: wire the boundary client + migrate seed-based trading tests

**Status:** ready to implement · **Repo:** `herobids` · **Branch:** `consume-traderton` (do NOT touch `main`)
**Scope:** test harness + functional test files ONLY. No production route code, no schema, no `main`.

---

## 0. TL;DR for the implementer

`herobids/scripts/shell/tests/run-all-tests.sh --e2e` currently fails **10 functional tests**
across 3 files. They share **one root cause**: the functional test harness builds a boundary
client mock but never passes it into three route registrations, so endpoints that now read
trading data over the REST boundary fail-closed with **HTTP 503**. A subset of the tests
additionally seed rows into local trading tables (`fills`, `positions`, `bots`, `venue_accounts`)
that **no longer exist** in herobids — they were dropped when trading moved behind the boundary —
so those `import`s resolve to `undefined` and the tests throw
`Cannot read properties of undefined (reading 'Symbol(drizzle:Columns)')`.

Fix = (1) thread the existing stub boundary client into the three route registrations, mirroring
production wiring; (2) make the stub's agent-scoped fills/positions reads **seedable**; (3) migrate
the affected tests to seed the mock instead of the dropped local tables.

**All 10 tests are being MIGRATED, none retired** — every one asserts logic that is still
herobids's responsibility (see §5).

---

## 1. Background — read this, you have no prior context

### The project
`herobids` is an AI-agent platform. A multi-slice epic has extracted all **trading** logic out of
herobids into a separate service called **traderton**, reached **over a REST boundary**, for legal
isolation. herobids no longer executes trades or stores trading state in-process; its trading
endpoints call the boundary over REST and shape/aggregate the results in-app.

As part of that epic, a set of **trading tables was dropped from the herobids database**:
`fills`, `positions`, `bots`, `venue_accounts`, `user_credentials`, `decisions`,
`decision_failures`, and others. Their drizzle schema objects were removed from `@herobids/db`.
Trading state now lives in traderton and arrives over the boundary; herobids reads it via boundary
"tools" such as `get_agent_fills` and `get_agent_positions`.

**KEEP tables (still exist, do NOT confuse with dropped ones):** `market_assessment_requests`,
`market_assessment_runs`, `market_assessment_artifacts`, `user_plans`, `agents`, `connections`,
`agent_connections`, `venue_accounts` is **dropped**, `billing_accounts` exists, etc. When in
doubt, verify with the command in §3.

### What already got fixed (do not redo)
Two harness bugs of the same family were already fixed and committed on this branch:
- `9b6301a9` — removed dropped tables from the `TRUNCATE` lists in
  `apps/api/src/__tests__/functional/helpers.ts` (`truncateAll`) and
  `apps/api/src/__tests__/functional/telegram-slash-commands.functional.test.ts`.
- `6a819cce` — updated a stale `liveRollout` assertion in `tests/staging-config-validation.test.ts`.

Those took the functional tier from **178 failures → 10**. This plan closes the remaining 10.

### Hard rules (do not break)
1. **herobids only, branch `consume-traderton`.** Never touch the sibling `traderton` repo. Never
   touch `main`. Never merge.
2. **Do NOT reintroduce trading into herobids.** Do not re-add dropped tables, do not add local
   trading execution/state, do not add a new in-process trading-package dependency. The correct
   source of trading data in a test is the **boundary mock**, never a local table.
3. **Do NOT change production route code** (`apps/api/src/routes/**`) to make tests pass. The
   production routes are correct (they already accept and use a boundary client — see §4). The bug
   is that the **test harness** doesn't pass one. If you believe a production route is genuinely
   wrong, STOP and report — do not patch it.
4. **Do NOT touch market-assessment behavior.** `market_assessment_*` ownership is under an open
   decision. One test inserts into `market_assessment_requests` (a KEEP table) — that insert is
   fine and must stay; do not alter market-assessment logic.
5. **Search with `rg` (ripgrep) in the shell.** The editor's glob/grep tool false-greens in this
   repo. Every "is this referenced" check must use ripgrep.
6. **Commits:** atomic, single-line `-m` (no backticks), explicit `git add` of specific files,
   never `--no-verify`. A benign identity/config warning on commit is expected — ignore it.

---

## 2. The failing tests (exact list)

Run produced `Tests 10 failed | 181 passed`. The 10, by file:

**`apps/api/src/__tests__/functional/trading-positions.functional.test.ts`** (5)
- `returns 404 for an agent belonging to another user`
- `returns empty items when agent has no binding or bots`
- `returns positions with derived exitPrice for closed positions`
- `returns open positions without exitPrice or hold duration`
- `paginates correctly with limit and offset`

**`apps/api/src/__tests__/functional/agent-interactivity.functional.test.ts`** (4 — the `/trades` block)
- `GET /agents/:id/trades > returns an empty trades array when the agent has no managed bots or native fills`
- `GET /agents/:id/trades > agent-native fills appear in response`
- `GET /agents/:id/trades > both agent-native and bot fills appear together`
- `GET /agents/:id/trades > agent with no bots — only agent-native fills`

**`apps/api/src/__tests__/functional/agents.functional.test.ts`** (2 — the `DELETE /agents/:id` block)
- `cascade-deletes dependent rows (sessions, artifacts, outbound messages, market assessment requests) with the agent`
- `deletes a stopped agent and returns 204`

Failure symptoms you will see: `expected 503 to be 200/204/404` (missing boundary client) and
`Cannot read properties of undefined (reading 'Symbol(drizzle:Columns)')` / `reading 'id'`
(seeding a dropped table whose drizzle object is now `undefined`).

---

## 3. Root cause (grounded)

The functional harness `buildApp()` in `apps/api/src/__tests__/functional/helpers.ts`:
- **Creates** the stub boundary client: `const stubTradertonClient = makeStubTradertonClient()`
  and returns it (around line 506, `tradertonClient: stubTradertonClient`), and passes it to
  *some* route registrations (setup, connections, etc.).
- **Does NOT pass it** to these three registrations (around lines 473–480):
  - `await agentRoutes(app, db, testPlansConfig as any);`
  - `await capabilityRoutes(app, db, testPlansConfig as any, TEST_BUDGETS, redisClient);`
  - `await agentInteractivityRoutes(app, db, redisClient, undefined, undefined, testPlansConfig as any);`

All three route functions accept an **optional** `tradertonReadClient` (verify signatures — see §4).
Because it is omitted, the endpoints that read over the boundary find no client and return the
fail-closed **503 precondition** (`boundaryUnconfiguredError`). That is *correct* production
behavior when no boundary is configured — the defect is purely that the test harness never wires
the mock in.

The seeding failures are a second layer: the affected tests still do
`ctx.db.insert(fills|positions|bots|venueAccounts)`, but those drizzle objects were removed from
`@herobids/db`, so they are `undefined` at runtime.

**Verify the dropped-vs-KEEP split before you start** (must match this plan):
```sh
cd /Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids
for t in fills positions bots venue_accounts market_assessment_requests billing_accounts user_plans; do
  if rg -q "pgTable\('$t'" packages/db/src/schema; then echo "EXISTS  $t"; else echo "DROPPED $t"; fi
done
# Expect: DROPPED fills, positions, bots, venue_accounts; EXISTS market_assessment_requests, billing_accounts, user_plans
```

---

## 4. The production wiring to mirror (reference — do NOT edit these files)

`apps/api/src/index.ts` already threads the real client (`tradertonBotClient`) into all three
routes. Use these as the exact reference for argument order and position:

- `capabilityRoutes(app, db, appConfig.plans, appConfig.agentRuntime.defaultBudgets, redisClient, tradertonBotClient, appConfig.boundary.requestTimeoutMs)`
  → client is the **6th** arg, timeout the **7th**.
- `agentRoutes(app, db, appConfig.plans, {…LlmCatalogDeps}, appConfig.agentRiskDefaults, appConfig.agentCostEstimates, redisClient, appConfig.agentRuntime.llm.modelDefaults, tradertonBotClient, appConfig.boundary.requestTimeoutMs)`
  → client is the **9th** arg, timeout the **10th**.
- `agentInteractivityRoutes(app, db, redisClient, appConfig.alerts, {…LlmCatalogDeps}, appConfig.plans, appConfig.agentRiskDefaults, tradertonBotClient, appConfig.boundary.requestTimeoutMs)`
  → client is the **8th** arg, timeout the **9th**.

Confirm each signature before wiring (the optional param is named `tradertonReadClient`):
```sh
rg -n "export async function (agentRoutes|capabilityRoutes|agentInteractivityRoutes)" apps/api/src/routes -A 14
```

The endpoints resolve trading data through `get_agent_positions` and `get_agent_fills`, then do
**in-app shaping in herobids** (pagination, `exitPrice` reconstruction, `holdMs`, agent+bot fill
merge, ownership 404). That in-app logic is what these tests protect. See
`apps/api/src/routes/capabilities/trading.ts` (`/agents/:agentId/capabilities/trading/positions`
handler, ~line 640) and `apps/api/src/routes/agent-interactivity.ts` (`/agents/:id/trades`, ~line 423).

---

## 5. Per-test disposition (all MIGRATE, none retire)

Each test asserts behavior that remains herobids's job (the boundary only *supplies rows*; herobids
shapes them). The separate cross-stack test tier proves the boundary returns data; it does NOT
prove herobids's shaping/pagination/merge — so none of these are redundant.

| Test | Asserts (herobids-owned) | Fix shape |
|---|---|---|
| positions: 404 other user | agent ownership guard | wire only |
| positions: empty items | empty-list response shape | wire only (mock returns empty) |
| positions: derived exitPrice | in-app exitPrice + holdMs + status | wire + seed mock |
| positions: open (no exitPrice) | open-position shaping | wire + seed mock |
| positions: pagination | in-app sort + limit/offset | wire + seed mock |
| /trades: empty | empty trades shape | wire only |
| /trades: agent-native fills | agent-native surfacing | wire + seed mock |
| /trades: agent + bot fills | herobids-side merge of agent+bot fills | wire + seed mock |
| /trades: only agent-native | agent-scoped filtering | wire + seed mock |
| DELETE cascade (2 tests) | DB ON DELETE CASCADE + delete flow | wire only |

---

## 6. Implementation

### Step 1 — Thread the stub client into the three route registrations
In `apps/api/src/__tests__/functional/helpers.ts`, `buildApp()`, update the three calls to pass
`stubTradertonClient` in the correct position (mirror §4). The stub is already constructed in this
function; use that same instance. Pass a small fixed timeout (e.g. the value already used elsewhere
in the file, or a literal like `5000`) for the trailing `tradertonReadTimeoutMs` where the
signature has one.

- `agentRoutes(...)` — add `stubTradertonClient` as the 9th arg. Note this call currently passes
  only 3 args; you must supply the intervening optional args. Pass the values the harness already
  has where available (plans, redisClient) and `undefined` for ones it does not (LlmCatalogDeps,
  agentCostEstimates, modelDefaults) — `undefined` is acceptable for those optionals; the only one
  that matters for these tests is the client. **Verify the exact positions against the signature**
  so the client lands in the `tradertonReadClient` slot, not an earlier one.
- `capabilityRoutes(...)` — add `stubTradertonClient` as the 6th arg (right after `redisClient`).
- `agentInteractivityRoutes(...)` — replace the trailing pattern so `stubTradertonClient` lands in
  the 8th (`tradertonReadClient`) slot.

Do NOT change the route source. If a signature differs from §4 when you read it, follow the actual
signature and report the discrepancy in your summary.

### Step 2 — Make the stub's agent reads seedable
In `makeStubTradertonClient()` (same file), the cases `get_agent_fills` and `get_agent_positions`
currently return hardcoded empty arrays (~lines 304–309). Add in-memory, per-agent seedable stores
and expose seed helpers so tests can inject rows.

- Add two maps keyed by `agentId`, e.g. `const agentFills = new Map<string, unknown[]>()` and
  `const agentPositions = new Map<string, unknown[]>()`.
- `get_agent_fills` returns `{ ok: true, fills: agentFills.get(<agentId from subject/payload>) ?? [] }`.
  Determine the agent id the endpoint scopes by — inspect `input.subject` (the agent-scoped reads
  use an agent subject; confirm by reading how `agentReadBoundary`/`loadAgentEvidence` build the
  subject in `capabilities/trading.ts` and `agent-interactivity.ts`). Key the store by that id.
- `get_agent_positions` returns `{ ok: true, positions: agentPositions.get(<agentId>) ?? [] }`.
- Expose seed functions on the returned object (alongside `invoke`), e.g.
  `seedAgentFills(agentId, rows)` and `seedAgentPositions(agentId, rows)`, and surface them from
  `buildApp()` so tests can call `ctx.seedAgentFills(...)`. Keep the `TradertonClient` cast intact;
  attach the helpers as extra properties on the returned object and expose them via the `buildApp`
  return value (not by widening the `TradertonClient` type).

**Row shape:** the endpoint maps boundary rows via `toFillRow` / `toPositionRow`
(`apps/api/src/routes/exports-traderton.ts`). Those mappers **spread the record unchanged** and only
rehydrate date fields (`filledAt`, `createdAt`; `openedAt`, `closedAt`, `updatedAt`) from ISO
strings to `Date`. So a seeded row is just the **same object shape the test used to insert into the
dropped table**, with date fields as ISO strings (e.g. `filledAt: '2026-06-17T10:00:00.000Z'`).
Numeric/decimal columns are strings (e.g. `price: '1.0'`, `realizedPnl: '10.95'`), exactly as
before.

### Step 3 — Migrate the seeding tests
For the "wire + seed mock" tests in §5, replace `ctx.db.insert(fills|positions|bots|venueAccounts)…`
with the new seed helpers. Remove the now-invalid `import { fills, positions, bots, venueAccounts }
from '@herobids/db'` lines (those objects no longer exist).

- **`trading-positions.functional.test.ts`:** remove the `bots/fills/positions/venueAccounts`
  imports and the `seedBotWithPositions` DB inserts. For the exitPrice/open/pagination tests, seed
  the mock: `ctx.seedAgentPositions(agentId, [ …position rows… ])` and
  `ctx.seedAgentFills(agentId, [ …fill rows… ])` using the same field values the test currently
  inserts (dates as ISO strings). The endpoint reconstructs `exitPrice` from the seeded fills — keep
  the fill's `filledAt`, `actorType`, `actorId`, `venueAccountId`, `venue`, `symbol`, `price` so the
  correlation logic matches the position. The assertions on the response body stay unchanged.
- **`agent-interactivity.functional.test.ts` `/trades` block:** remove the `fills/bots/venueAccounts`
  imports and DB inserts; seed agent fills via `ctx.seedAgentFills(agentId, [...])`. For the
  "agent + bot fills together" test, the endpoint's `get_agent_fills` boundary tool already folds
  agent-owned bot fills server-side (see the route comment ~line 419), so seed BOTH the agent-native
  and the bot fill into the single `get_agent_fills` result for that agent — do not try to recreate
  a local `bots` row. The response assertions (counts, `actorType`, `actorId`) stay unchanged.

### Step 4 — The wire-only tests need no seeding change
- **`agents.functional.test.ts` DELETE block:** after Step 1 wires `agentRoutes`, these pass. The
  `market_assessment_requests` and `billing_accounts` inserts stay as-is (KEEP tables). Do NOT
  modify market-assessment logic. The test asserts DB `ON DELETE CASCADE`; the only reason it was
  503 is the missing boundary client (agent-delete tears down bots over the boundary).
- **positions "empty items" and /trades "empty":** pass on Step 1 alone (mock returns empty).

---

## 7. Verification

Bring up infra and run the affected tiers directly (bounded output). The functional tier is
DB-backed and **self-skips unless `DATABASE_URL` and `REDIS_URL` are exported** — if you see
"skipped", your env is not set.

```sh
cd /Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids

# infra
docker compose up -d
# schema (NOTE: migrations run via the compose `migrate` service, NOT `pnpm migrate`)
docker compose -f docker-compose.yaml run --rm migrate

# env the runner uses (without it, functional tests skip → false green)
export DATABASE_URL="postgres://herobids:herobids@localhost:5432/herobids"
export REDIS_URL="redis://localhost:6379"
export CREDENTIAL_ENCRYPTION_KEY="$(grep -E '^CREDENTIAL_ENCRYPTION_KEY=' .env | cut -d= -f2- | tr -d '[:space:]')"

# static checks
pnpm build      > /tmp/fix-build.log 2>&1 || tail -n 80 /tmp/fix-build.log
pnpm lint       > /tmp/fix-lint.log  2>&1 || tail -n 80 /tmp/fix-lint.log

# the affected tier
pnpm test:functional > /tmp/fix-func.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/fix-func.log | tail -3
```

Pass criteria for the tier: `Tests … 0 failed` and the count of *running* (non-skipped) tests is
what you expect (≈191 with env set — NOT "189 skipped", which means env missing).

Then the full sequence (the real gate). It brings up its own stack + boundary and runs Playwright:
```sh
scripts/shell/tests/run-all-tests.sh --e2e > /tmp/fix-e2e.log 2>&1; echo "exit=$?"
grep -aE "^  (PASS|FAIL) " /tmp/fix-e2e.log
tail -n 40 /tmp/fix-e2e.log
```
All tiers must read `PASS` (Unit, Integration, Functional, API smoke ×4, E2E Playwright).

**Memory hygiene:** these logs are large. Redirect to files and read only the failing tail; do not
stream full logs into context. If you loop many times, checkpoint with a commit and consider a fresh
session.

---

## 8. Commit

Commit atomically on `consume-traderton`. Suggested split:
```sh
git add apps/api/src/__tests__/functional/helpers.ts
git commit -m "test(isolation): wire stub boundary client into functional route registrations"

git add apps/api/src/__tests__/functional/trading-positions.functional.test.ts \
        apps/api/src/__tests__/functional/agent-interactivity.functional.test.ts \
        apps/api/src/__tests__/functional/agents.functional.test.ts
git commit -m "test(isolation): seed boundary mock instead of dropped trading tables"
```
(If the seedable-mock change and the wiring change are hard to separate cleanly, one combined commit
is acceptable — keep it focused on the harness fix.)

---

## 9. Out of scope / do not touch

- Production route code under `apps/api/src/routes/**` (correct as-is).
- `apps/api/src/routes/blueprints.integration.test.ts` — it is NOT in the `test:integration`
  include list and self-skips without `DATABASE_URL`; it also imports dropped tables. It is an
  already-orphaned test, unrelated to these 10. Leave it; if you think it needs attention, report
  it separately, do not fix it here.
- Any `market_assessment_*` behavior, schema, or ownership.
- The `traderton` repo and `main` on either repo.

---

## 10. Report back

- Which route signatures you confirmed and the exact arg positions you used.
- The functional-tier result (running count + 0 failed) and the full `--e2e` tier results.
- Any production-route discrepancy you found (and did NOT patch).
- Commits made.

---

## 11. Outstanding Issues (from code review — all LOW)

**[2026-09-17 — implemented via commits e962f3e2 + d67aef0e; review verdict PASS, no HIGH/MEDIUM findings]**

- [LOW] [Step 2] `helpers.ts` — `get_agent_fills`/`get_agent_positions` stub fallback keys on `''` when the subject actor is not agent-typed; a row seeded under `''` would leak into a user-subject read. Fails safe today (both routes are agent-scoped, no test seeds `''`). Hardening: return `[]` when the actor is not an agent.
- [LOW] [Step 2] `helpers.ts` — `StubTradertonClientWithSeed` type is declared after `buildApp()` (types hoist, so it compiles); moving it next to `makeStubTradertonClient()` would read better.
- [LOW] [Step 2] `helpers.ts` — the two seed-closure wrappers in `buildApp()`'s return each re-cast `stubTradertonClient as StubTradertonClientWithSeed`; destructure once.
- [LOW] [Step 2/3] Seed rows are typed `Record<string, unknown>`/`unknown[]`; a shared exported row-shape type (or JSDoc on `seedAgentFills`) would give compile-time protection against forgetting `createdAt` (currently a runtime 500).
- [LOW] [Housekeeping] This plan doc was untracked at implementation time; commit it separately for the record.

Implementation notes (report per §10): signatures confirmed — `agentRoutes` 9th of 10, `capabilityRoutes` 6th of 7, `agentInteractivityRoutes` 8th of 9 — all matching §4; no production-route discrepancy found. Seeded rows required explicit `createdAt` (the `toFillRow` mapper rehydrates it unconditionally and throws without it); added as `<filledAt>` — consistent with the mapper contract. Functional tier: 191 passed / 0 failed. Full `--e2e` gate: all 9 tiers PASS from a clean shell (unit tier fails only if `DATABASE_URL`/`REDIS_URL` leak into the invoking shell — pre-existing harness artifact, not caused by this change).

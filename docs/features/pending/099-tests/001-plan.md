# PLAN: Regression Tests for Agent Decision & Trade History Bugs

**Status:** Draft
**Created:** 2026-06-17
**Related:** [000-problem.md](./000-problem.md)

---

## Goal

Add regression tests that would have caught the two bugs discovered in agent `63d1f7c1` (t1inch): canonical token resolution silently failing and agent-native fills missing from trade history.

---

## Test 1: Canonical Token Fallback in `resolveSwapTokenData`

**File:** `apps/worker/src/__tests__/swap-token-safety.test.ts` (new)
**Layer:** Unit (mock-based)

### Test cases

| # | Scenario | Mock setup | Assert |
|---|----------|-----------|--------|
| 1 | Canonical lookup succeeds, DexScreener returns no match | `canonical.resolve('ETH')` → WETH address; `dexscreener.search()` → `[]` | Returns `ResolvedSwapTokenData` with canonical defaults (symbol=WETH, decimals from canonical entry) |
| 2 | No canonical match, DexScreener returns no match | `canonical.resolve('UNKNOWN')` → `null`; `dexscreener.search()` → `[]` | Returns `null` (token.not_found) |
| 3 | Canonical lookup succeeds, DexScreener returns a match | `canonical.resolve('ETH')` → WETH address; `dexscreener.search()` → pool results with WETH pair | Returns DexScreener-resolved data (existing path — verify no regression) |
| 4 | Canonical lookup fails, DexScreener returns a match | `canonical.resolve('UNKNOWN')` → `null`; `dexscreener.search()` → pool results | Returns DexScreener-resolved data (existing path — verify no regression) |

### Dependencies to mock

- `createCanonicalTokenResolver` — return a resolver that maps ETH → WETH address on Base
- `DexScreenerProvider.search` — return `[]` for test 1 & 2, pool results for 3 & 4
- No real HTTP calls needed

---

## Test 2: Agent-Native Fills in Trade History Endpoint

**File:** `apps/api/src/routes/__tests__/agent-interactivity.functional.test.ts` (add to existing describe block)
**Layer:** Functional (existing harness, real DB via test container)

### Test cases

| # | Scenario | Setup | Assert |
|---|----------|-------|--------|
| 1 | Agent-native fills appear in response | Insert `actorType='agent'`, `actorId=$agentId` fill row into `fills` table | `GET /agents/:id/trades` returns the agent-native fill in `trades[]` |
| 2 | Both agent-native and bot fills appear together | Insert agent-native fill + bot fill (bot created by agent) | Response contains both fills, ordered correctly |
| 3 | Agent with no bots — only agent-native fills | Insert agent-native fill, ensure no bots exist for agent | Response contains only the agent-native fill |
| 4 | Existing "no bots → empty array" still passes | No fills, no bots | Response is `[]` (verify no regression) |

### Dependencies

- Uses existing functional test harness in `tests/e2e/helpers.ts`
- Seeds data via Drizzle insert into the test DB
- Authenticates as the agent's user

---

## Implementation Order

1. **Test 1** (swap-token-safety.unit.test.ts) — fastest to write, most isolated, mocks only
2. **Test 2** (agent-interactivity.functional.test.ts additions) — uses existing harness, requires DB schema knowledge for `fills` table columns

---

## Files to Create / Modify

| Action | File |
|--------|------|
| Create | `apps/worker/src/__tests__/swap-token-safety.test.ts` |
| Modify | `apps/api/src/routes/__tests__/agent-interactivity.functional.test.ts` (add 3 new test cases) |

---

## Acceptance Criteria

- All 4 unit tests pass (`pnpm test`)
- All 4 functional tests pass (`pnpm test:functional` or `pnpm test:integration`)
- `pnpm lint` passes
- Tests are deterministic (no real HTTP, no timing dependencies)

# PROBLEM

## Summary of Bugs

**Agent `63d1f7c1` (t1inch)** has 6 `go_long` decisions but zero trades. I found and fixed **two independent bugs**:

### Bug 1: Token Safety Fails for Canonical Tokens (5 of 6 decisions)
- **File:** index.ts — `resolveSwapTokenData()`
- **What happened:** The operator configured ETH as a canonical alias for WETH on Base chain. The canonical lookup correctly resolved ETH → WETH address, but when DexScreener returned no results (likely rate-limited across 3 concurrent agents sharing a 30 req/min budget), the entire token resolution failed with `token.not_found`.
- **Fix:** When a canonical token is found but DexScreener returns no match, we now construct a synthetic `ResolvedSwapTokenData` from the canonical entry with safe defaults — canonical tokens are operator-whitelisted and don't need external verification.

### Bug 2: Trade History Endpoint Misses Agent-Native Fills
- **File:** agent-interactivity.ts — `GET /agents/:id/trades`
- **What happened:** The query only looked for `actorType='bot'` fills from agent-created bots. Agent-native fills (`actorType='agent'`) were never returned, so even successful decisions would show "No trade history."
- **Fix:** Added `actorType='agent' AND actorId=$agentId` to the query, joined with OR alongside the existing bot-fills condition.

### Verification
- `pnpm lint` (tsc --noEmit) — passes cleanly
- agent-intake-resolver.test.ts — all 20 tests pass
- Bug report filed at 001-agent-decisions-no-trades.md

### Remaining Issues (not fixed — advisory)
| Issue | Recommendation |
|-------|---------------|
| **HYPE on Base** | HYPE is a Hyperliquid token, not available on Base DEXes. Reconfigure agent to use Hyperliquid venue or remove HYPE from its instruments. |
| **Sizing (5000 BTC)** | Agent proposed $329M notional against $1,000 capital. Needs prompt guidance that `targetSize` is token quantity, not USD. (Related to bug #009) |
| **DexScreener rate limits** | 3 agents sharing 30 req/min may cause starvation. Consider increasing the budget or adding retry with backoff. |

After re-deploying, agent decisions for canonical tokens (ETH/USDC on Base) should produce paper fills that appear in trade history.

## Analysis: Do Existing Tests Prevent These Bugs?

### Bug 1: Canonical Token Fallback in `resolveSwapTokenData`

**What went wrong:** When DexScreener returned no results (rate-limited), `resolveSwapTokenData` returned `null` for canonical tokens that should have been safe to use with synthetic defaults.

**Coverage assessment:**

| Test layer | Coverage? | Notes |
|---|---|---|
| agent-intake-resolver.test.ts (unit) | **No** | Tests `AgentIntakeResolver` — the intake/decision pipeline, not token safety or swap token resolution. |
| Unit tests (`pnpm test`) | **Partial** | The fix was verified by "all 20 tests pass" in agent-intake-resolver.test.ts, but those tests mock the mark source and don't exercise `resolveSwapTokenData` or the token safety adapter at all. |
| Integration tests (`pnpm test:integration`) | **No** | Tests DB + auth flows, not market data resolution. |
| Functional tests (`pnpm test:functional`) | **No** | The functional tests for agent-interactivity don't include a test case for agent-native fills in the trades endpoint (only tests empty trades array). No test hits `resolveSwapTokenData` with a canonical token + DexScreener failure scenario. |
| E2E tests (`--e2e`) | **No** | Venue integration tests are excluded from the suite (require real API keys). The agent-trade-test is manual-only. |
| agent-trade-test.ts (manual smoke test) | **No** | Tests Hyperliquid venue by default; doesn't exercise 1inch swap token safety or canonical token resolution on Base. |

**Verdict: No existing test catches this.** The fix added a synthetic fallback path in `resolveSwapTokenData`, but there is no unit test that exercises: (a) canonical token lookup succeeds, (b) DexScreener returns empty/no match, and (c) the function still returns a valid `ResolvedSwapTokenData`.

---

### Bug 2: Trade History Endpoint Misses Agent-Native Fills

**What went wrong:** `GET /agents/:id/trades` only queried `actorType='bot'` fills from agent-created bots. Agent-native fills (`actorType='agent'`) were invisible.

**Coverage assessment:**

| Test layer | Coverage? | Notes |
|---|---|---|
| agent-interactivity.functional.test.ts | **No** | The existing test for `GET /agents/:id/trades` only asserts that an agent with no managed bots returns an empty array. It does not test: (a) agent-native fills appearing, or (b) the OR-join between agent-native and bot-fills conditions. |
| Unit tests | **No** | No unit tests for the API route handler. |
| Integration/Functional tests | **No** | Same gap — no test inserts an `actorType='agent'` fill and verifies it appears in the response. |
| E2E / agent-trade-test | **No** | The manual smoke test checks position state, not the trade history API endpoint specifically. |

**Verdict: No existing test catches this.** The single existing test case only covers the "no bots" happy path returning an empty array. It never inserts a fill row or verifies that both actor types appear.

---

### What Would Prevent These Bugs

Here's what I'd suggest adding:

#### 1. Unit test for canonical token fallback (in __tests__)

```typescript
// In a new file like apps/worker/src/__tests__/swap-token-safety.test.ts

describe('resolveSwapTokenData', () => {
  it('returns synthetic data when canonical lookup succeeds but DexScreener returns no match', async () => {
    // Mock: canonical ETH → WETH address resolves
    // Mock: dexscreener.search returns empty array (rate-limited / no pools)
    // Assert: returns ResolvedSwapTokenData with canonical defaults (not null)
  });

  it('returns null when no canonical match AND DexScreener returns no match', async () => {
    // Mock: canonical lookup returns null (unknown token)
    // Mock: dexscreener.search returns empty array
    // Assert: returns null (token.not_found)
  });
});
```

#### 2. Functional test for agent-native fills in trade history (in functional)

```typescript
// Add to agent-interactivity.functional.test.ts

describe('GET /agents/:id/trades', () => {
  // ... existing "empty trades" test ...

  it('returns agent-native fills alongside bot fills', async () => {
    // Insert: actorType='agent', actorId=agentId fill row
    // Insert: actorType='bot', actorId=botId fill row (bot created by agent)
    // Assert: both fills appear in response.trades
  });

  it('returns only agent-native fills when agent has no bots', async () => {
    // Insert: actorType='agent' fill, no bots exist
    // Assert: response contains the agent-native fill
  });
});
```

#### 3. Consider adding a lightweight integration test for `resolveSwapTokenData`

This is trickier since it depends on `createProviderRegistry` and DexScreener. Options:
- **Mock-based unit test** (preferred): Mock `registry.dexscreener.search` to return empty, verify synthetic fallback.
- **Integration test with mocked HTTP**: Use `nock` or `undici` mock dispatcher to intercept DexScreener calls.

---

### Summary Table

| Bug | Unit tests | Integration tests | Functional tests | E2E / manual smoke | Gap severity |
|-----|-----------|-------------------|-----------------|-------------------|-------------|
| Canonical token fallback | ❌ | ❌ | ❌ | ❌ | **HIGH** — silent decision rejection |
| Agent-native fills in trade history | ❌ | ❌ | ❌ (partial: empty array only) | ❌ | **MEDIUM** — visibility bug, not correctness |

The existing test infrastructure (run-all-tests.sh) is solid for its current scope, but these two bugs fell through the cracks because:

1. **`resolveSwapTokenData` has no dedicated tests** — it's a module-level function in index.ts that sits outside any tested class.
2. **The functional test for `GET /agents/:id/trades` only covers the empty case** — it asserts the happy path of "no bots → empty array" but never exercises the actual query logic with real data.

Both fixes are straightforward to add as regression tests in their respective test files.
# Plan: Apply TechnicalConfig & IntelligenceConfig Zod Defaults at DB Read Boundary (TDD)

**Goal:** Ensure `getUnifiedConfig()` returns `TechnicalConfig` and `IntelligenceConfig` with all Zod schema defaults applied, so consumers never encounter `undefined` for defaulted fields like `scanBatchSize`, `scanIntervalMs`, `candles`, `signalBias`, and `autonomousExit`.

**Bug:** `docs/bug-reports/2026/07/16/003-technical-config-scan-defaults-not-applied-at-load.md`

**Strategy:** Write failing tests first (Red), then implement the minimal fix (Green), then verify edge cases (Refactor/confirm).

## Task Status

| # | Item | Status |
|---|------|--------|
| 1 | Phase 1 — Test 1: `TechnicalConfigSchema` defaults (`schema.test.ts`) | DONE |
| 2 | Phase 1 — Test 2: `getUnifiedConfig` technical defaults (`agent-repository.test.ts`) | PENDING |
| 3 | Phase 1 — Test 3: `getUnifiedConfig` intelligence defaults (`agent-repository.test.ts`) | PENDING |
| 4 | Phase 2 — Create `applyConfigDefaults()` helper (`agent-repository.ts`) | PENDING |
| 5 | Phase 2 — Call from `getUnifiedConfig()`, verify all tests pass | PENDING |
| 6 | Phase 4 — Shell smoke test (`agent-config-defaults-smoke-test.ts` + `.sh`) | PENDING |

---

## Phase 1 — Failing Tests (Red)

### Test 1: `TechnicalConfigSchema` defaults — all fields (`packages/domain/src/config/schema.test.ts`)

**Why:** The schema only tests `autonomousExit` default today. We need comprehensive coverage of EVERY defaulted field.

```typescript
describe('TechnicalConfigSchema — defaults', () => {
  const minimal = { filters: { venue: 'hyperliquid', venueType: 'orderbook' } };

  it('defaults scanBatchSize to 5', () => {
    const result = TechnicalConfigSchema.parse(minimal);
    expect(result.scanBatchSize).toBe(5);
  });

  it('defaults scanIntervalMs to 60_000', () => {
    const result = TechnicalConfigSchema.parse(minimal);
    expect(result.scanIntervalMs).toBe(60_000);
  });

  it('defaults candles to { interval: "15m", limit: 100 }', () => {
    const result = TechnicalConfigSchema.parse(minimal);
    expect(result.candles).toEqual({ interval: '15m', limit: 100 });
  });

  it('defaults signalBias to "trend-following"', () => {
    const result = TechnicalConfigSchema.parse(minimal);
    expect(result.signalBias).toBe('trend-following');
  });

  it('defaults autonomousExit to false', () => {
    const result = TechnicalConfigSchema.parse(minimal);
    expect(result.autonomousExit).toBe(false);
  });

  it('defaults indicators to a populated object with sub-indicator defaults', () => {
    const result = TechnicalConfigSchema.parse(minimal);
    expect(result.indicators).toBeDefined();
    expect(typeof result.indicators).toBe('object');
    expect(result.indicators).not.toBeNull();
    // Zod recursively applies sub-indicator defaults — not {} but a fully-populated object
  });
});
```

**Expected:** These pass immediately (Zod `.default()` already works at the schema level). This is a **regression safety net** — not a failing test, but a gap we need to fill.

### Test 2: `getUnifiedConfig()` applies `TechnicalConfigSchema` defaults (`packages/db/src/agent-repository.test.ts`)

**Why:** This is the actual failing test. `getUnifiedConfig()` returns raw JSONB — even if the schema defines defaults, they're never applied at read time.

```typescript
describe('AgentRepository.getUnifiedConfig — technical config defaults', () => {
  it('returns scanBatchSize=5 when technical config omits it', async () => {
    // Insert agent with minimal technical config (only filters, no scanBatchSize)
    await db.insert(agents).values({
      id: 'agent-minimal',
      userId: 'user-1',
      name: 'minimal',
      status: 'active',
      unifiedConfig: {
        capabilityMode: 'hybrid',
        hybridMode: 'scanner_gated',
        technical: {
          filters: { venue: 'hyperliquid', venueType: 'orderbook' },
        },
      },
    });

    const config = await repo.getUnifiedConfig('agent-minimal');
    expect(config).not.toBeNull();
    expect(config!.technical).toBeDefined();
    expect(config!.technical!.scanBatchSize).toBe(5);   // ← FAILS TODAY — is undefined
    expect(config!.technical!.scanIntervalMs).toBe(60_000); // ← FAILS TODAY
    expect(config!.technical!.candles).toEqual({ interval: '15m', limit: 100 }); // ← FAILS TODAY
    expect(config!.technical!.signalBias).toBe('trend-following'); // ← FAILS TODAY
    expect(config!.technical!.autonomousExit).toBe(false); // ← FAILS TODAY
  });

  it('does not override explicitly-set values', async () => {
    await db.insert(agents).values({
      id: 'agent-explicit',
      userId: 'user-1',
      name: 'explicit',
      status: 'active',
      unifiedConfig: {
        capabilityMode: 'hybrid',
        hybridMode: 'scanner_gated',
        technical: {
          filters: { venue: 'hyperliquid', venueType: 'orderbook' },
          scanBatchSize: 10,
          scanIntervalMs: 30_000,
        },
      },
    });

    const config = await repo.getUnifiedConfig('agent-explicit');
    expect(config!.technical!.scanBatchSize).toBe(10);     // explicit value preserved
    expect(config!.technical!.scanIntervalMs).toBe(30_000); // explicit value preserved
  });

  it('returns null technical when technical is absent from stored config', async () => {
    await db.insert(agents).values({
      id: 'agent-no-tech',
      userId: 'user-1',
      name: 'no-tech',
      status: 'active',
      unifiedConfig: {
        capabilityMode: 'intelligence',
        // no technical key
      },
    });

    const config = await repo.getUnifiedConfig('agent-no-tech');
    expect(config!.technical).toBeUndefined(); // absent → absent, not defaulted
  });
});
```

**Expected: ALL assertions about defaults FAIL today** — `scanBatchSize`, `scanIntervalMs`, `candles`, `signalBias`, `autonomousExit` are all `undefined` when not stored in JSONB.

### Test 3: `IntelligenceConfigSchema` defaults (same pattern, `packages/db/src/agent-repository.test.ts`)

**Why:** `IntelligenceConfigSchema` has defaults too (`wakeIntervalMs`, `maxTokens`). Same gap.

```typescript
describe('AgentRepository.getUnifiedConfig — intelligence config defaults', () => {
  it('applies intelligence config defaults when fields are omitted', async () => {
    await db.insert(agents).values({
      id: 'agent-intel-min',
      userId: 'user-1',
      name: 'intel-min',
      status: 'active',
      unifiedConfig: {
        capabilityMode: 'intelligence',
        intelligence: {}, // empty object
      },
    });

    const config = await repo.getUnifiedConfig('agent-intel-min');
    expect(config!.intelligence).toBeDefined();
    // Verify defaults are applied (exact assertions depend on IntelligenceConfigSchema defaults)
  });
});
```

---

## Phase 2 — Implementation (Green)

### Step 1: Create a `applyConfigDefaults()` helper in `packages/db/src/agent-repository.ts`

```typescript
import { TechnicalConfigSchema, IntelligenceConfigSchema } from '@herobids/domain';

function applyConfigDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const result = { ...raw };

  // Apply TechnicalConfigSchema defaults if technical block exists
  if (result['technical'] && typeof result['technical'] === 'object') {
    try {
      result['technical'] = TechnicalConfigSchema.parse(result['technical']);
    } catch {
      // If parsing fails, leave as-is — callers handle invalid config elsewhere
    }
  }

  // Apply IntelligenceConfigSchema defaults if intelligence block exists
  if (result['intelligence'] && typeof result['intelligence'] === 'object') {
    try {
      result['intelligence'] = IntelligenceConfigSchema.parse(result['intelligence']);
    } catch {
      // Same — leave as-is on parse failure
    }
  }

  return result;
}
```

### Step 2: Call it from `getUnifiedConfig()`

```typescript
async getUnifiedConfig(agentId: string): Promise<UnifiedAgentConfig | null> {
    const rows = await this.db.select({ unifiedConfig: agents.unifiedConfig })
      .from(agents).where(eq(agents.id, agentId)).limit(1);
    const raw = rows[0]?.unifiedConfig ?? null;
    if (!raw) return null;

    const withCapabilityDefaults = applyCapabilityModeMigrationDefaults(raw as Record<string, unknown>);
    const withAllDefaults = applyConfigDefaults(withCapabilityDefaults);
    return withAllDefaults as UnifiedAgentConfig;
}
```

### Step 3: Run tests — all Phase 1 tests should now pass

### Step 4: Run full test suite

```bash
pnpm lint
pnpm test
```

---

## Phase 3 — Edge Cases & Refinement

### Edge cases to verify manually

| Case | Expected behavior |
|------|-------------------|
| Agent has no `technical` key in `unifiedConfig` | `config.technical` is `undefined` — scanner loop silently skipped (existing behavior preserved) |
| `technical` is present but malformed (e.g., `scanBatchSize: "not-a-number"`) | Zod parse fails in the `catch` block → original value preserved → let downstream handle or log |
| `technical` has ALL fields explicitly set | Explicit values preserved; defaults do NOT override |
| `technical.filters` is `null` or `undefined` | `TechnicalConfigSchema.parse()` fails on missing required `filters` field → original preserved → caller handles |
| Agent is `intelligence` mode with no `intelligence` key | `config.intelligence` is `undefined` — no-op |
| Existing agents with already-complete configs | No change — explicit values unchanged; defaults only fill gaps |

### Verify on staging

1. Run the DB migration SQL to patch existing agents (optional, since `getUnifiedConfig()` now applies defaults at read time):
   ```sql
   -- Not strictly needed after fix, but good for consistency:
   UPDATE agents 
   SET unified_config = jsonb_set(
     jsonb_set(unified_config, '{technical,scanBatchSize}', '5'),
     '{technical,scanIntervalMs}', '60000'
   )
   WHERE status = 'active' 
     AND unified_config->'capabilityMode' = '"hybrid"'
     AND unified_config->'technical'->'scanBatchSize' IS NULL;
   ```
2. Restart worker
3. Check logs for `candidatesScored > 0` and `signalsGenerated > 0`

---

## Phase 4 — Shell Smoke Test (E2E)

A TypeScript-based shell test (mirrors `scripts/ts/agent-config-matrix-test.ts` pattern). Requires running Docker stack + API. Verifies the full pipeline: API → DB → config read → worker scan → signals in logs.

**File:** `scripts/ts/agent-config-defaults-smoke-test.ts`
**Shell wrapper:** `scripts/shell/tests/agent-config-defaults-smoke-test.sh`

### Scenario 1 (happy path): Minimal config produces signals

1. **Create** hybrid agent via `POST /agents` with `capabilityMode: "hybrid"`, `hybridMode: "scanner_gated"`, and a `technical` block containing only `filters` + `indicators` + `candles` + `signalBias` — **omitting** `scanBatchSize` and `scanIntervalMs`
2. **Start** the agent via `POST /agents/:id/start`
3. **Assert** DB: `unified_config->'technical'->'scanBatchSize'` is either absent (before fix) or `5` (after fix)
4. **Poll** worker logs for `candidatesScored: <non-zero>` within 2× expected scan interval (120s timeout)
5. **Assert** at least one log line matches `candidatesScored: <N>` where N > 0
6. **Stop** and **delete** the agent

### Scenario 2: Explicit values preserved

1. **Create** hybrid agent with `scanBatchSize: 10` and `scanIntervalMs: 30_000` explicitly set
2. **Start** the agent
3. **Assert** DB: stored values are `10` and `30000` (not overridden by defaults)
4. **Poll** worker logs for `candidatesScored > 0`
5. **Assert** log timestamps between consecutive `Technical phase complete` lines are ~30s apart (not 60s)
6. **Stop** and **delete** the agent

### Scenario 3: Intelligence-mode agent unaffected

1. **Create** intelligence agent with `capabilityMode: "intelligence"` and no `technical` block
2. **Start** the agent
3. **Assert** DB: `unified_config->'technical'` is NULL
4. **Assert** worker logs do NOT contain `Technical phase complete` for this agent
5. **Assert** agent health endpoint returns `healthy`
6. **Stop** and **delete** the agent

### Scenario 4: PATCH preserves defaults

1. **Create** hybrid agent with minimal config (omit `scanBatchSize`/`scanIntervalMs`)
2. **Start** the agent, verify `candidatesScored > 0`
3. **PATCH** the agent to change `signalBias` from `"trend-following"` to `"mean-reverting"` (only send the changed field, not full technical block)
4. **Assert** DB: after PATCH, `scanBatchSize` and `scanIntervalMs` are still present (not stripped)
5. **Poll** worker logs for `candidatesScored > 0` after PATCH (scanner loop restarted with new config)
6. **Stop** and **delete** the agent

### Scenario 5: Multi-agent coexistence (nice-to-have, deferred to `agent-trade-test.sh`)

- Start one hybrid agent (scenario 1) and one intelligence agent (scenario 3) simultaneously
- Hybrid produces signals, intelligence doesn't crash, neither interferes

---

## Files Changed

| File | Change |
|------|--------|
| `packages/domain/src/config/schema.test.ts` | Add `TechnicalConfigSchema` defaults test cases |
| `packages/db/src/agent-repository.test.ts` | Add `getUnifiedConfig` defaults tests (the actual failing tests) |
| `packages/db/src/agent-repository.ts` | Add `applyConfigDefaults()` helper; call it from `getUnifiedConfig()` |
| `scripts/ts/agent-config-defaults-smoke-test.ts` | **New** — Shell smoke test (Phase 4) |
| `scripts/shell/tests/agent-config-defaults-smoke-test.sh` | **New** — Shell wrapper for the smoke test |

## Files NOT Changed

- `apps/worker/src/technical-phase.ts` — no change needed; schema defaults fix the `undefined` issue
- `apps/worker/src/agent-trading-actor.ts` — no change needed
- `apps/worker/src/index.ts` — no change needed (config flows through `getUnifiedConfig`)
- `apps/api/src/routes/agents.ts` — no change needed (API write path is fine; the gap is at read time)
- `packages/domain/src/config/schema.ts` — no change needed (schema already correct)

## Why This Approach

1. **Fix at the right boundary**: The DB read layer is the single source of truth for config shape. Applying defaults here fixes the problem for ALL consumers (worker, API reads, backtests, evaluations).
2. **Minimal blast radius**: Two files changed, no schema changes, no API changes, no worker logic changes.
3. **Backward compatible**: Explicitly-set values are preserved. Only absent fields get defaults.
4. **Safe on parse failures**: If a stored config is somehow malformed, the `catch` preserves the original — no crash, no data loss. The malformed config will fail elsewhere with a clear error.
5. **E2E safety net**: The shell smoke test catches this bug class even if the unit tests are bypassed — it validates the full API → DB → worker → logs pipeline end-to-end.

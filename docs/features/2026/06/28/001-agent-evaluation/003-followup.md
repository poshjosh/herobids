## 1. Cost data collection (`costs.json`)

**Key insight:** `billingUsageEvents` already has an `agentId` column (with an index `idx_billing_usage_events_agent_occurred`), so there's no account-mapping problem — we can query usage events by agentId directly.

**What to change:**

evidence-assembler.ts

Replace the placeholder block that currently writes `collected: false` with an actual query:

```typescript
// Instead of:
entries.push({ artifactName: 'costs.json', collected: false, error: 'Agent-level cost collection not yet implemented' });

// Do:
try {
  const billingEvents = await ctx.db
    .select({
      meterKey: billingUsageEvents.meterKey,
      quantity: billingUsageEvents.quantity,
      unit: billingUsageEvents.unit,
      model: billingUsageEvents.model,
      provider: billingUsageEvents.provider,
      occurredAt: billingUsageEvents.occurredAt,
    })
    .from(billingUsageEvents)
    .where(and(
      eq(billingUsageEvents.agentId, ctx.agentId),
      ...(timeFilter?.from ? [gte(billingUsageEvents.occurredAt, timeFilter.from)] : []),
      ...(timeFilter?.to ? [lte(billingUsageEvents.occurredAt, timeFilter.to)] : []),
    ))
    .orderBy(billingUsageEvents.occurredAt);

  // Summarize by meterKey
  const summary = summarizeByMeter(billingEvents);
  await ctx.store.write(ctx.runId, 'costs.json', JSON.stringify(summary, null, 2));
  entries.push({ artifactName: 'costs.json', collected: true, itemCount: billingEvents.length });
} catch (err) {
  entries.push({ artifactName: 'costs.json', collected: false, error: String(err) });
}
```

Add a small helper to aggregate `{meterKey, totalQuantity, unit}` from the raw events. Import `billingUsageEvents` and `and, eq, gte, lte` from `@herobids/db`.

**Files touched:** 1 file, ~30 lines net new.

---

## 2. Redundant `loadAgentBotIds` calls

**Problem:** When the evidence assembler calls all 4 loaders in sequence, `loadAgentBotIds` runs 4 times — once per loader.

**Fix:** Pre-fetch bot IDs once and pass them to each loader as an optional parameter. Add an optional `botIds?: string[]` parameter to `loadAgentFills`, `loadAgentJournalEvents`, `loadAgentPositions`. When provided, skip the internal `loadAgentBotIds` call.

**What to change:**

agent-evidence-loaders.ts

```typescript
// Current signature:
export async function loadAgentFills(db: Database, agentId: string, opts?: LoaderTimeFilter)

// New signature:
export async function loadAgentFills(db: Database, agentId: string, opts?: LoaderTimeFilter & { botIds?: string[] })
```

In the body, use `opts?.botIds ?? await loadAgentBotIds(db, agentId)`. Apply the same to journal and positions loaders (sessions don't need bot IDs).

evidence-assembler.ts

At the top of `assembleEvidence()`:
```typescript
import { loadAgentBotIds } from '@herobids/db';
// ...
const botIds = await loadAgentBotIds(ctx.db, ctx.agentId);
// Then pass { ...timeFilter, botIds } to each loader
```

**Files touched:** 2 files, ~15 lines net new.

---

## 3. Redis snapshot wiring

**What to change:**

evaluation-runtime.ts

The `EvaluationRuntimeConfig` already has `redis: { host, port, ... }` for BullMQ. Add a second Redis client for the snapshot capability:

```typescript
import Redis from 'ioredis';

// In the start() method, create a snapshot-capable client:
const snapshotRedis = new Redis(this.config.redis);
const redisSnapshot = {
  snapshot: async () => {
    // Collect relevant keys: agent state, session data, active watches
    const keys = await snapshotRedis.keys(`agent:${agentId}:*`);
    const result: Record<string, unknown> = {};
    for (const key of keys.slice(0, 100)) { // limit to prevent overload
      const type = await snapshotRedis.type(key);
      if (type === 'string') result[key] = await snapshotRedis.get(key);
      else if (type === 'hash') result[key] = await snapshotRedis.hgetall(key);
    }
    return result;
  },
};
```

Pass this to `runEvaluation()` via the `redis` field already wired in `RunEvaluationContext`.

**Files touched:** 1 file, ~25 lines.

---

## 4. Container logs collector

Create a new file:

`apps/worker/src/agent-evaluation/collectors/container-logs.ts`

Two approaches, depending on infrastructure:

**Option A — Docker logs (simplest):**
```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export async function collectContainerLogs(
  agentId: string,
  store: EvaluationArtifactStore,
  runId: string,
): Promise<EvidenceManifestEntry> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'logs', `herobids-agent-${agentId}`,
      '--tail', '500',  // last 500 lines
    ], { timeout: 10_000 });
    await store.write(runId, 'container-logs.txt', stdout);
    return { artifactName: 'container-logs.txt', collected: true };
  } catch {
    return { artifactName: 'container-logs.txt', collected: false, error: 'Container logs unavailable' };
  }
}
```

**Option B — Agent API endpoint (cleaner, more portable):**

If the agent runtime exposes a logs endpoint, call that instead. Otherwise, start with Option A as best-effort.

Wire it into the assembler by calling it after the Redis snapshot block:

```typescript
const logsEntry = await collectContainerLogs(ctx.agentId, ctx.store, ctx.runId);
entries.push(logsEntry);
```

**Files touched:** 1 new file + 1 edit to assembler, ~30 lines.

---

## 5. API route tests

Create `apps/api/src/routes/agent-evaluations.test.ts` following the existing pattern from exports.test.ts:

```typescript
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { agentEvaluationRoutes } from './agent-evaluations.js';
import type { EvaluationJobData } from '@herobids/db';

function buildDb(selectSequence: unknown[][]) { /* same pattern as exports.test.ts */ }

describe('POST /agents/:id/evaluations', () => {
  it('enqueues a latestSession evaluation and returns 202 with runId', async () => { ... });
  it('returns 404 for unknown agent', async () => { ... });
  it('returns 404 when agent has no completed sessions (latestSession)', async () => { ... });
  it('returns 400 for invalid scope', async () => { ... });
  it('returns 400 for allTime scope without ?allowAllTime=true', async () => { ... });
  it('returns 202 for allTime scope with ?allowAllTime=true', async () => { ... });
  it('returns 409 when a run is already active for the same scope', async () => { ... });
  it('enqueues with session scope when sessionId provided', async () => { ... });
  it('enqueues with timeRange scope when from/to provided', async () => { ... });
});

describe('GET /agents/:id/evaluations', () => {
  it('returns paginated run list', async () => { ... });
  it('returns 404 for unknown agent', async () => { ... });
  it('respects limit/offset query params', async () => { ... });
});

describe('GET /agents/:id/evaluations/:runId', () => {
  it('returns run with scorecard and summary', async () => { ... });
  it('returns 404 for unknown run', async () => { ... });
  it('returns 404 when run belongs to different agent', async () => { ... });
});

describe('GET /agents/:id/evaluations/:runId/artifacts', () => {
  it('returns artifact manifest', async () => { ... });
  it('returns empty list when no artifacts exist', async () => { ... });
});

describe('GET /agents/:id/evaluations/:runId/artifacts/:name', () => {
  it('streams artifact with correct Content-Type', async () => { ... });
  it('returns 404 for unknown artifact name', async () => { ... });
});
```

The mock queue doesn't need to be a real BullMQ Queue — a plain object with `add: vi.fn()` works:

```typescript
const mockQueue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) } as unknown as Queue<EvaluationJobData>;
```

The mock store (for artifact routes) just needs to implement `read`, `list`, `write`:

```typescript
const mockStore = {
  read: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  write: vi.fn(),
};
```

**Files touched:** 1 new file, ~250 lines.

---

## 6. `run-evaluation` integration test

Create `apps/worker/src/agent-evaluation/run-evaluation.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runEvaluation } from './run-evaluation.js';
import { FsEvaluationArtifactStore } from '@herobids/db';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';

function mockDb(selectSequence: unknown[][]) { /* same builder pattern */ }

describe('runEvaluation', () => {
  let store: FsEvaluationArtifactStore;
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `eval-run-test-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    store = new FsEvaluationArtifactStore(root);
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('completes a full session-scoped evaluation end-to-end', async () => {
    // ... seed mock DB with session, fills, journal, positions
    // ... run the orchestrator
    // ... verify evaluation.json and REPORT.md exist in store
  });

  it('marks the run as succeeded with correct scorecard', async () => { ... });
  it('marks the run as retrying when attemptNumber < maxAttempts and an error occurs', async () => { ... });
  it('marks the run as failed when attemptNumber === maxAttempts and an error occurs', async () => { ... });
  it('aborts when session timestamps are missing for session scope', async () => { ... });
  it('runs all analyzers and produces findings', async () => { ... });
});
```

The key verification is that `evaluation.json` and `REPORT.md` exist in the store after the run, with correct structure.

**Files touched:** 1 new file, ~200 lines.

---

## 7. `allTime` scope admin gating (LOW)

agent-evaluations.ts

Currently gated by `?allowAllTime=true` query param. To make it operator-only:

```typescript
if (scope.type === 'allTime') {
  // Check if request has an admin role claim (already available on request)
  if (!request.isAdmin) {
    return reply.status(403).send({ error: 'forbidden', message: 'allTime scope requires admin privileges' });
  }
}
```

This needs the admin middleware to set `request.isAdmin`. Check if there's already an admin auth hook — if not, it's a larger change touching auth. Alternatively, keep the query-param gate but change the error from 400 to 403 and the message to "requires operator approval".

**Files touched:** 1 file, ~5 lines.

---

## 8. LLM narrative (LOW — Level 2)

run-evaluation.ts

When `includeNarrative` is true, after the report is rendered, make a structured LLM call:

```typescript
if (includeNarrative) {
  const narrativePrompt = buildNarrativePrompt(scorecard, allFindings);
  const narrative = await llmProvider.complete({
    system: 'You are an evaluation analyst...',
    messages: [{ role: 'user', content: narrativePrompt }],
  });
  // Append to report
}
```

The `buildNarrativePrompt` takes only the scorecard + top findings (no raw evidence), making it safe to send to an LLM. This needs the LLM provider to be threaded through `RunEvaluationContext` (similar to how `EvaluationRuntimeConfig` already has Redis config). The narrative is gated behind the `includeNarrative` flag that's alreadyRecovered from a request error

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/index.ts#80-80), lines 80 to 80

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/schema/agents.ts#30-30), lines 30 to 66

Searched for regex `new Redis\(|redisClient|redis\s*=` (`**/apps/worker/src/index.ts`), 20 results

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agent-evaluation/analyzers/core.ts#85-85), lines 85 to 110

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/usage-billing-repository.ts#760-760), lines 760 to 870

Here's a concrete implementation plan for each outstanding item, ordered by effort and dependency.

---

## 1. Cost data collection (MEDIUM)

**Discovery:** `billingUsageEvents` already has an `agentId` column with an index `idx_billing_usage_events_agent_occurred`. No account-linking hop needed for Level 1.

**Implementation in evidence-assembler.ts:**

Replace the placeholder block (currently ~lines 162-169) with a direct query:

```typescript
// ── Cost data ──────────────────────────────────────────────────────────
try {
  const usageEvents = await db
    .select({
      meterKey: billingUsageEvents.meterKey,
      totalQuantity: sql<number>`sum(${billingUsageEvents.quantity})`,
      totalCosts: sql<number>`count(*)`,
    })
    .from(billingUsageEvents)
    .where(and(
      eq(billingUsageEvents.agentId, ctx.agentId),
      ...(timeFilter?.from ? [gte(billingUsageEvents.occurredAt, timeFilter.from)] : []),
      ...(timeFilter?.to ? [lte(billingUsageEvents.occurredAt, timeFilter.to)] : []),
    ))
    .groupBy(billingUsageEvents.meterKey);

  await ctx.store.write(ctx.runId, 'costs.json', JSON.stringify(usageEvents, null, 2));
  entries.push({ artifactName: 'costs.json', collected: true, itemCount: usageEvents.length });
} catch (err) {
  entries.push({ artifactName: 'costs.json', collected: false, error: String(err) });
}
```

**Imports needed:** `billingUsageEvents` from `@herobids/db`, `and`, `eq`, `gte`, `lte`, `sql` from `drizzle-orm`.

**Stop rule:** cost data is best-effort (catch block stays). If the billing table doesn't exist or the agent has no usage, it's `collected: false`, not a fatal error.

---

## 2. Redundant bot-ID queries (MEDIUM)

**Problem:** Each of the 4 loaders calls `loadAgentBotIds(db, agentId)` independently. In `assembleEvidence`, the bots table is queried 4 times for the same agent.

**Implementation in evidence-assembler.ts:**

Pre-resolve bot IDs once and inject them into each loader call. This requires adding an optional `preResolvedBotIds?: string[]` parameter to each loader function in agent-evidence-loaders.ts:

```typescript
// In each loader, add the optional param and short-circuit:
export async function loadAgentFills(
  db: Database,
  agentId: string,
  opts?: LoaderTimeFilter,
  preResolvedBotIds?: string[],
): Promise<typeof fills.$inferSelect[]> {
  const agentBotIds = preResolvedBotIds ?? await loadAgentBotIds(db, agentId);
  // ... rest unchanged
}
```

Then in `assembleEvidence`, pre-fetch once:

```typescript
const agentBotIds = await loadAgentBotIds(ctx.db, ctx.agentId);

// Then pass to each loader:
const fills = await loadAgentFills(ctx.db, ctx.agentId, timeFilter, agentBotIds);
const journal = await loadAgentJournalEvents(ctx.db, ctx.agentId, timeFilter, agentBotIds);
// ... etc
```

**Files touched:** agent-evidence-loaders.ts (4 function signatures), evidence-assembler.ts (1 pre-fetch + 4 call sites), exports.ts (4 call sites — pass `undefined` to keep existing behavior).

**Risk:** Low. The `preResolvedBotIds` param is optional with fallback to the existing query. Existing callers (API exports) are unchanged.

---

## 3. Redis snapshot wiring (MEDIUM)

**Discovery:** `redisClient` (an `ioredis` instance) already exists in index.ts at line 157 and is passed to many components.

**Implementation:**

**Step A — Create a thin adapter in the evaluation tree** (`apps/worker/src/agent-evaluation/collectors/redis-snapshot.ts`):

```typescript
import type Redis from 'ioredis';

export interface RedisSnapshotClient {
  snapshot(): Promise<Record<string, unknown>>;
}

export function createRedisSnapshotClient(redis: Redis): RedisSnapshotClient {
  return {
    snapshot: async () => {
      // Collect a best-effort snapshot of agent-related keys
      const keys = await redis.keys('agent:*');
      const result: Record<string, unknown> = {};
      if (keys.length === 0) return result;
      const pipeline = redis.pipeline();
      for (const key of keys) {
        pipeline.type(key);
      }
      const types = await pipeline.exec();
      if (!types) return result;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const typeResult = types[i]?.[1];
        if (typeResult === 'string') {
          result[key] = await redis.get(key);
        } else if (typeResult === 'hash') {
          result[key] = await redis.hgetall(key);
        }
      }
      return result;
    },
  };
}
```

**Step B — Wire it in index.ts** (around line 1246 where `EvaluationRuntime` is created):

```typescript
const evaluationRuntime = new EvaluationRuntime(
  {
    redis: redisConnection,
    concurrency: appConfig.evaluation.concurrency,
    maxRuntimeMs: appConfig.evaluation.maxRuntimeMs,
    thresholds: appConfig.evaluation.thresholds,
    // Pass the snapshot client:
    redisSnapshot: createRedisSnapshotClient(redisClient),
  },
  db,
);
```

**Step C — Thread through `EvaluationRuntimeConfig`** → `RunEvaluationContext` → `assembleEvidence`. The context chain is already prepared (`ctx.redis` on the assembler), so this is just passing the value.

**Files touched:** New `redis-snapshot.ts`, `worker/src/index.ts` (~3 lines), evaluation-runtime.ts (~2 lines in config interface + pass-through).

**Constraints:** Redis is best-effort. If the snapshot call fails, the assembler's existing try/catch records a manifest error without aborting the evaluation. Keys are scoped to `agent:*` to avoid pulling in unrelated data.

---

## 4. Container-logs collector (MEDIUM)

**Implementation in new file** `apps/worker/src/agent-evaluation/collectors/container-logs.ts`:

This is inherently best-effort since container logs are external to the application. The simplest Level 1 approach uses `docker logs`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EvaluationArtifactStore } from '@herobids/domain';

const execFileAsync = promisify(execFile);

export interface ContainerLogsContext {
  store: EvaluationArtifactStore;
  runId: string;
  /** Docker container name or ID for this agent */
  containerName?: string;
  /** Max log lines to fetch */
  maxLines?: number;
  /** Log timestamp range filter */
  since?: Date;
  until?: Date;
}

export async function collectContainerLogs(ctx: ContainerLogsContext): Promise<{ collected: boolean; error?: string }> {
  if (!ctx.containerName) {
    return { collected: false, error: 'No container name configured for this agent' };
  }

  try {
    const args = ['logs', '--timestamps', '--tail', String(ctx.maxLines ?? 500)];
    if (ctx.since) args.push('--since', ctx.since.toISOString());
    if (ctx.until) args.push('--until', ctx.until.toISOString());
    args.push(ctx.containerName);

    const { stdout } = await execFileAsync('docker', args, {
      timeout: 10_000,
      maxBuffer: 5 * 1024 * 1024, // 5 MB
    });

    await ctx.store.write(ctx.runId, 'container-logs.txt', stdout);
    return { collected: true };
  } catch (err) {
    return { collected: false, error: String(err) };
  }
}
```

**Integration:** Call from `assembleEvidence` after the other collectors, catch and record as a manifest entry. The container name would need to be passed through the context chain, or derived from the agent's name/id convention used by docker-agent-manager.ts.

**Stop rule:** Don't block on this. The plan marks it as best-effort. If Docker isn't available (e.g., agent running in a different host), it silently records `collected: false`.

---

## 5. API route tests (LOW)

**New file:** `apps/api/src/routes/agent-evaluations.test.ts`

**Pattern:** Follow exports.test.ts exactly. Use Fastify's `app.inject()` with a mocked DB built from the `buildDb()` helper pattern.

**Tests needed** (7-10 tests):

| Method | Path | Test case |
|--------|------|-----------|
| POST | `/agents/:id/evaluations` | Returns 202 + `{ runId }` on valid `latestSession` scope |
| POST | `/agents/:id/evaluations` | Returns 404 when agent has no completed sessions |
| POST | `/agents/:id/evaluations` | Returns 409 when active run exists for same scope |
| POST | `/agents/:id/evaluations` | Returns 400 when `allTime` requested without `?allowAllTime=true` |
| POST | `/agents/:id/evaluations` | Returns 400 for invalid scope body |
| GET | `/agents/:id/evaluations` | Returns paginated list of runs |
| GET | `/agents/:id/evaluations/:runId` | Returns single run with scorecard |
| GET | `/agents/:id/evaluations/:runId/artifacts` | Returns artifact manifest |
| GET | `/agents/:id/evaluations/:runId/artifacts/:name` | Returns 404 for unknown artifact name |
| GET | `/agents/:id/evaluations/:runId` | Returns 404 when run doesn't belong to agent |

**Mock setup:** The test needs to mock the BullMQ `Queue` (for enqueue) and the artifacts store (for listing/download). The `buildDb` pattern re-used from exports.test.ts works for the DB queries.

**Estimated effort:** ~1-2 hours following existing patterns.

---

## 6. Orchestrator integration test (LOW)

**New file:** `apps/worker/src/agent-evaluation/run-evaluation.test.ts`

**Approach:** Test `runEvaluation()` with a mocked `Database`, `EvaluationArtifactStore`, and seeded data. Don't test through BullMQ — call the function directly.

**Tests needed** (4-6 tests):

| Test | Setup |
|------|-------|
| Happy path: session scope → evidence collected → analyzers run → `markSucceeded` called | Mock DB returns session timestamps, fills, journal, sessions, positions, agent metadata |
| Session not found → throws, `markFailed` called | Mock DB returns null for session lookup |
| Retryable failure → `markRetrying` called (not `markFailed`) | Set `attemptNumber: 1, maxAttempts: 3`, throw from evidence loader |
| Final attempt failure → `markFailed` called | Set `attemptNumber: 3, maxAttempts: 3`, throw from evidence loader |
| Time range scope → correct time filters applied | Verify `timeFilter` values passed to loaders |

**Mock pattern:**

```typescript
function buildMockStore(): EvaluationArtifactStore {
  const artifacts = new Map<string, Uint8Array>();
  return {
    write: vi.fn(async (runId, name, content) => {
      const buf = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      artifacts.set(`${runId}/${name}`, buf);
      return { name, mimeType: 'application/json', sizeBytes: buf.length };
    }),
    read: vi.fn(async (runId, name) => {
      const data = artifacts.get(`${runId}/${name}`);
      return data ?? null;
    }),
    list: vi.fn(async () => []),
  };
}
```

**Estimated effort:** ~2-3 hours. Most complex part is building the mock DB that returns realistic sequences for all loader queries.

---

## Summary — recommended implementation order

| # | Item | Files | Effort | Depends on |
|---|------|-------|--------|------------|
| 1 | Cost data | evidence-assembler.ts (15 lines) | 30 min | None |
| 2 | Bot-ID caching | agent-evidence-loaders.ts, evidence-assembler.ts, exports.ts | 1 hr | None |
| 3 | Redis snapshot | New `redis-snapshot.ts`, index.ts, evaluation-runtime.ts | 1 hr | None |
| 4 | API route tests | New `agent-evaluations.test.ts` | 2 hr | None |
| 5 | Orchestrator test | New `run-evaluation.test.ts` | 3 hr | None |
| 6 | Container logs | New `container-logs.ts`, evidence-assembler.ts | 2 hr | None (best-effort) |

Items 1-3 can be done in parallel. Items 4-5 are tests that validate the existing (and newly-fixed) behavior. Item 6 is the lowest priority since it's explicitly best-effort and depends on Docker availability.
# Artifact Retention Purging

**Created:** 2026-08-30  
**Status:** pending  
**Severity:** LOW  
**Depends on:** None

## Problem

The `agent_artifacts` table stores metadata for every artifact an agent publishes via `publish_artifact`. Each row includes `retentionClass` (`ephemeral`, `standard`, `permanent`) and an optional `expiresAt` timestamp — but no automated process purges expired or stale rows.

Today, artifacts are only removed when an agent is deleted (Postgres `ON DELETE CASCADE` on `agent_id`). For long-running agents that produce frequent outputs (analysis reports, monitoring summaries, research findings), the table will grow unbounded.

### Impact

- **Unbounded table growth** — Every publish appends a row. A busy agent producing 10 artifacts/day accumulates ~3,600 rows/year.
- **Dead data** — Ephemeral artifacts (tool traces, transient summaries) have no purpose beyond the current session but persist forever.
- **Inert schema fields** — `retentionClass` and `expiresAt` imply a lifecycle policy that doesn't exist, misleading anyone reading the schema.

### What exists today

| Artifact field | Purpose | Currently enforced? |
|---|---|---|
| `retentionClass` | `ephemeral` / `standard` / `permanent` | No — all treated identically |
| `expiresAt` | Explicit expiry timestamp | No — never checked |
| `ON DELETE CASCADE` on `agentId` | Remove artifacts when agent is deleted | Yes — Postgres FK |

## Scope

This plan covers:
1. A periodic artifact reaper job in the worker that physically deletes expired rows
2. Default `expiresAt` assignment when the agent doesn't provide one
3. Operator config for retention defaults and reaper cadence
4. Zod config schema for validation

It does NOT cover:
- S3 / object-storage body cleanup (future follow-up — use S3 lifecycle policies for now)
- Exposing a `get_artifact` or `list_artifacts` tool to agents (separate feature)
- Changing the `publish_artifact` tool interface (backward compatible)

## Design

### Retention class semantics

| Class | Default `expiresAt` | Reaper behavior | Use case |
|---|---|---|---|
| `ephemeral` | `createdAt + ephemeralRetainMs` (default: 24 hours) | Deleted when expired | Tool traces, transient summaries, intermediate analysis |
| `standard` | `createdAt + standardRetainMs` (default: 30 days) | Deleted when expired | Analysis reports, trade reviews, published monitoring outputs |
| `permanent` | `null` (no expiry) | Never reaped | Compliance artifacts, audit-critical records |

If the agent provides an explicit `expiresAt`, it takes precedence over the class-based default. The reaper does not distinguish — it deletes any row where `expiresAt < now()`, regardless of class.

### Default `expiresAt` assignment

Applied at insert time in `AgentRepository.insertArtifact()`:

```
if expiresAt was provided → use it
else if retentionClass is 'permanent' → leave null (no expiry)
else → compute from retentionClass defaults in operator config
```

This keeps the logic at the data layer (repository), not the tool layer, so all artifact inserts (current and future) get defaults consistently.

### Reaper job

**Pattern:** `setInterval` in `apps/worker/src/index.ts`, matching the existing approval-expiry sweep and bot-orphan sweep convention.

```
Every artifactReaper.intervalMs (default: 1 hour):
  1. DELETE FROM agent_artifacts
     WHERE expires_at IS NOT NULL
       AND expires_at < now()
     LIMIT batchSize (default: 500)
  2. Log deleted count
  3. If deleted === batchSize, schedule immediate re-run (drain large backlogs)
```

Physical DELETE (not soft-delete) because:
- Artifacts are non-authoritative audit data (per schema comment)
- The agent has no read-back tool — deleted artifacts are invisible to everyone
- Keeps the table lean without requiring a second sweep for purged rows
- FK cascade on `agentId` already implies physical deletion is acceptable

### Operator config

New top-level section in `config/default.yaml`:

```yaml
artifactRetention:
  enabled: true                    # master switch — false disables the reaper entirely
  intervalMs: 3600000              # 1 hour — reaper sweep cadence
  batchSize: 500                   # max rows per DELETE batch (prevents long-held locks)
  ephemeralRetainMs: 86400000      # 24 hours — default TTL for ephemeral artifacts
  standardRetainMs: 2592000000     # 30 days — default TTL for standard artifacts
```

### Edge cases

| Case | Behavior |
|------|----------|
| Agent sets explicit `expiresAt` | Honored as-is, overrides class default |
| Agent sets `retentionClass: permanent` | `expiresAt` stays `null`, never reaped |
| Agent sets `retentionClass: permanent` AND explicit `expiresAt` | `expiresAt` wins — will be reaped (explicit intent) |
| Reaper disabled (`enabled: false`) | No periodic sweep — rows accumulate (safe default for cautious rollout) |
| Massive backlog (first run after long period) | Batch loop drains in increments of `batchSize` to avoid lock contention |
| Agent deleted while reaper running | No conflict — FK cascade and DELETE are both idempotent |
| Worker restarts mid-sweep | No state to lose — next interval starts fresh |
| Multiple workers running | Safe — DELETE with LIMIT is idempotent; worst case is redundant zero-row deletes |

## Implementation

### Step 1: Add Zod config schema for artifact retention

**File:** `packages/domain/src/config/schema.ts`

Add `ArtifactRetentionConfigSchema`:

```typescript
export const ArtifactRetentionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMs: z.number().int().min(60_000).default(3_600_000),
  batchSize: z.number().int().min(1).max(5000).default(500),
  ephemeralRetainMs: z.number().int().min(0).default(86_400_000),
  standardRetainMs: z.number().int().min(0).default(2_592_000_000),
});
```

Register in `AppConfigSchema`:
```typescript
artifactRetention: ArtifactRetentionConfigSchema.default({}),
```

### Step 2: Add operator config defaults

**File:** `config/default.yaml`

```yaml
artifactRetention:
  enabled: true
  intervalMs: 3600000          # 1 hour
  batchSize: 500
  ephemeralRetainMs: 86400000  # 24 hours
  standardRetainMs: 2592000000 # 30 days
```

### Step 3: Apply default `expiresAt` at insert time

**File:** `packages/db/src/agent-repository.ts` — `insertArtifact()`

Before inserting, compute `expiresAt` if not provided:

```typescript
async insertArtifact(input: InsertAgentArtifact): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();

  let effectiveExpiresAt = input.expiresAt ?? null;
  if (!effectiveExpiresAt && input.retentionClass !== 'permanent') {
    const retainMs = input.retentionClass === 'ephemeral'
      ? this.retentionConfig.ephemeralRetainMs
      : this.retentionConfig.standardRetainMs;
    effectiveExpiresAt = new Date(now.getTime() + retainMs);
  }

  await this.db.insert(agentArtifacts).values({
    id,
    agentId: input.agentId,
    sessionId: input.sessionId,
    artifactType: input.artifactType,
    contentType: input.contentType,
    summary: input.summary,
    location: input.location ?? null,
    metadata: input.metadata ?? null,
    retentionClass: input.retentionClass ?? 'standard',
    expiresAt: effectiveExpiresAt,
  });
  return id;
}
```

The `retentionConfig` (containing `ephemeralRetainMs` and `standardRetainMs`) is injected via the repository constructor, sourced from operator config.

### Step 4: Add `purgeExpiredArtifacts` repository method

**File:** `packages/db/src/agent-repository.ts`

```typescript
async purgeExpiredArtifacts(batchSize: number): Promise<number> {
  const now = new Date();
  const expired = await this.db
    .delete(agentArtifacts)
    .where(
      and(
        isNotNull(agentArtifacts.expiresAt),
        lte(agentArtifacts.expiresAt, now),
      ),
    )
    .limit(batchSize)
    .returning({ id: agentArtifacts.id });
  return expired.length;
}
```

### Step 5: Wire reaper interval into worker

**File:** `apps/worker/src/index.ts`

```typescript
// ── Artifact retention reaper ────────────────────────────────────────────────
let artifactReaperInterval: ReturnType<typeof setInterval> | undefined;
if (appConfig.artifactRetention.enabled) {
  const reaperConfig = appConfig.artifactRetention;

  const runReaper = async (): Promise<void> => {
    try {
      const deleted = await agentRepo.purgeExpiredArtifacts(reaperConfig.batchSize);
      if (deleted > 0) {
        logger.info({ deleted }, 'Artifact reaper: purged expired artifacts');
      }
      // Drain backlog: if we hit the batch limit, there may be more
      if (deleted >= reaperConfig.batchSize) {
        setImmediate(() => void runReaper());
      }
    } catch (err) {
      logger.error({ err }, 'Artifact reaper sweep failed');
    }
  };

  artifactReaperInterval = setInterval(() => void runReaper(), reaperConfig.intervalMs);
  logger.info({ intervalMs: reaperConfig.intervalMs }, 'Artifact retention reaper started');
}
```

Add `clearInterval(artifactReaperInterval)` to both `SIGTERM` and `SIGINT` handlers.

### Step 6: Backfill `expiresAt` for existing rows

**File:** New migration in `packages/db/src/migrations/`

One-time SQL migration to set `expiresAt` for existing rows that have `retentionClass` set but `expiresAt IS NULL` and `retentionClass != 'permanent'`:

```sql
UPDATE agent_artifacts
SET expires_at = created_at + INTERVAL '24 hours'
WHERE retention_class = 'ephemeral'
  AND expires_at IS NULL;

UPDATE agent_artifacts
SET expires_at = created_at + INTERVAL '30 days'
WHERE retention_class = 'standard'
  AND expires_at IS NULL;
```

This ensures the reaper can clean up pre-existing artifacts without waiting for them to be re-published.

## Default `expiresAt` recommendation

| Retention class | Default TTL | Rationale |
|---|---|---|
| `ephemeral` | **24 hours** | Tool traces, transient summaries — useful only for same-session or next-day debugging. 24h gives enough time for post-session review without accumulating cruft. |
| `standard` | **30 days** | Analysis reports, trade reviews — valuable for historical context and pattern review. 30 days covers a full monthly review cycle while keeping growth bounded. A busy agent (10 artifacts/day) accumulates ~300 rows before the oldest start expiring. |
| `permanent` | **No expiry** | Compliance or audit-critical artifacts — operator explicitly opts in. These are expected to be rare. |

The 24h/30d defaults are operator-configurable, so teams that need longer retention can adjust without code changes.

## Testing

1. **Unit: default `expiresAt` computation** — Verify `insertArtifact` sets correct `expiresAt` for each `retentionClass` when none is provided, and preserves explicit `expiresAt` when given.
2. **Unit: permanent class** — Verify `insertArtifact` leaves `expiresAt` as `null` for `retentionClass: permanent` when no explicit value is provided.
3. **Unit: explicit `expiresAt` overrides permanent** — Verify that `retentionClass: permanent` with an explicit `expiresAt` uses the explicit value.
4. **Unit: `purgeExpiredArtifacts`** — Insert rows with mixed `expiresAt` (past, future, null). Verify only past-expired rows are deleted and count matches.
5. **Unit: batch limiting** — Insert more expired rows than `batchSize`. Verify exactly `batchSize` rows are deleted per call.
6. **Unit: config validation** — Verify `ArtifactRetentionConfigSchema` rejects `intervalMs < 60_000`, `batchSize < 1`, `batchSize > 5000`.
7. **Integration: reaper drain loop** — Verify that when deleted count equals `batchSize`, the reaper re-runs immediately until the backlog is drained.
8. **Integration: reaper disabled** — Verify no interval is created when `artifactRetention.enabled` is `false`.
9. **Migration: backfill** — Run migration against a test DB with pre-existing rows. Verify ephemeral rows get `created_at + 24h`, standard rows get `created_at + 30d`, permanent rows stay `null`.

## Dependencies

- `packages/db/src/schema/agent-artifacts.ts` — existing table schema (no changes needed)
- `packages/db/src/agent-repository.ts` — `insertArtifact()` method (modified)
- `packages/domain/src/config/schema.ts` — `AppConfigSchema` (extended)
- `config/default.yaml` — operator config (extended)
- `apps/worker/src/index.ts` — worker startup (extended)

## Risks

- **Backfill migration on large tables** — If `agent_artifacts` has many rows, the UPDATE in step 6 could be slow. Mitigate: run in batches (e.g., `UPDATE ... WHERE id IN (SELECT id ... LIMIT 1000)`), or accept it as a one-time cost during a maintenance window.
- **Batch DELETE lock contention** — Large batch deletes can hold row locks. Mitigated by the `batchSize` cap (default 500) and the incremental drain pattern.
- **Multiple workers racing** — Two workers could run the reaper simultaneously. This is safe (DELETE is idempotent, worst case is one gets 0 rows) but wastes a query. Acceptable at current scale; add a Redis-based distributed lock if worker count grows significantly.
- **S3 body orphans** — Deleting the metadata row leaves the S3 object. Mitigate with S3 lifecycle policies on the artifact bucket, or add S3 cleanup in a future iteration.

## Future work

- **S3 body cleanup** — Before deleting a metadata row, check `location.bucket/key` and issue an S3 `DeleteObject`. Requires S3 client injection into the reaper.
- **`list_artifacts` / `get_artifact` agent tools** — Let the agent read back its own artifacts, making `publish_artifact` a full read-write channel.
- **Retention policy UI** — Let users configure per-agent retention overrides (e.g., "keep all artifacts for agent X for 90 days").
- **Metrics** — Emit reaper metrics (rows deleted per sweep, table size) for operational dashboards.

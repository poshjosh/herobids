# Bug Report: Rotation-Triggered Restart Crashes — Job Payload Missing Instance Config

- **Status:** CLOSED
- **Severity:** High
- **Date:** 2026-05-31
- **Discovered:** Stage C verification Test 4 (post-rotation readiness) — instance crashed immediately after credential rotation
- **Summary:** When credential rotation triggers a restart of dependent trading instances, the enqueued BullMQ job contains only `{ command: 'restart', tradingInstanceId }` — no `config` field. The worker's restart handler passed `config ?? {}` (an empty object) to `startInstance()`, which failed Zod validation with `strategy: Required; venue: Required; symbol: Required`.

## Symptoms

Worker log after rotation:

```json
{
  "level": 50,
  "tradingInstanceId": "f6a723e1-...",
  "err": "Invalid config for instance f6a723e1-...: strategy: Required; venue: Required; symbol: Required",
  "msg": "Instance start failed — marking crashed"
}
```

Instance transitions: `running` → (rotation) → restart job → `crashed`. The credential rotation itself succeeds, but the instance never comes back.

## Root Cause

Two contributing factors:

1. **`apps/api/src/routes/credentials.ts`** (rotation route) enqueues restart jobs without config:
   ```typescript
   await queue.add('restart-instance', {
     command: 'restart',
     tradingInstanceId: instanceId,
     // config is NOT included
   });
   ```

2. **`apps/worker/src/runtime.ts`** (`processJob` restart case) did not fall back to loading config from DB:
   ```typescript
   case 'restart':
     await this.stopInstance(tradingInstanceId);
     await this.startInstance(tradingInstanceId, config ?? {});
     // config is undefined → {} → Zod rejects
   ```

The `start` command path (from the instances route) includes config in the job payload. The `reclaimOrphans` path loads config from DB. But the `restart` path assumed config would always be provided — which is only true for explicit restart requests, not rotation-triggered ones.

## Fix

Modified the `restart` case in `apps/worker/src/runtime.ts` to load config from DB when not provided:

```typescript
case 'restart':
  await this.stopInstance(tradingInstanceId);
  let restartConfig = config;
  if (!restartConfig || Object.keys(restartConfig).length === 0) {
    if (this.instanceLoader) {
      const instances = await this.instanceLoader();
      const found = instances.find(i => i.id === tradingInstanceId);
      restartConfig = found?.config;
    }
    if (!restartConfig || Object.keys(restartConfig).length === 0) {
      throw new Error(`No config available for restart of instance ${tradingInstanceId}`);
    }
  }
  await this.startInstance(tradingInstanceId, restartConfig);
```

## Impact

- Any credential rotation on a running instance would crash that instance permanently
- The rotation itself succeeds (credential is re-encrypted), so the operator sees "rotated" but the instance is dead
- Requires manual intervention to restart the instance (or wait for reclaim sweep, which would work since the instance is still `running` in DB)

## Prevention

- The restart job should be self-sufficient: either include config in the payload, or the handler must always load from DB
- Unit test: rotation-triggered restart with no config in job payload should still succeed
- Consider making `config` always loaded from DB for restart (single source of truth) rather than trusting job payloads

## Regression Tests

Added to `apps/worker/src/runtime.test.ts`:

> **`WorkerRuntime restart — missing config in job payload (bug 2026-05-31-002 regression)`**

Three cases:
- **Loads config from instanceLoader when restart job has no config** — sends `{ command: 'restart', botId }` with no `config` field; verifies `instanceLoader` is called and the actorFactory receives the loaded config.
- **Throws when restart job has no config and no instanceLoader is registered** — verifies the error message `'No config available for restart of instance ...'` is thrown.
- **Uses the job payload config directly and does not call instanceLoader** — sends a restart job with an explicit `config`; verifies `instanceLoader` is NOT called.

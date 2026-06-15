# System Skill Startup Sync

Automatically upsert system skill rows from `packages/domain/src/skills.ts` into
the `skills` table every time the API starts, so the DB is always in sync with
the code without requiring manual intervention or a new migration.

## Background

System skills (those with `author_id = NULL`) are currently seeded by the
`0004_seed_system_skills` migration. That migration runs once per database. If
a skill's `instructions`, `requiredTools`, `contextRequirements`, or any other
field changes in `SYSTEM_SKILLS`, the DB row is silently stale until someone
manually re-seeds or drops and re-runs the migration.

Meanwhile the runtime (worker and API) reads `SYSTEM_SKILLS` directly from
memory — the in-memory definitions and the DB copy can diverge immediately after
any code change, with no warning.

`truncateAll()` in the functional test helpers already reconciles this correctly
using `onConflictDoNothing()`, but that is test-only and is a truncate-and-reseed,
not an upsert. The same logic promoted to production startup as an idempotent
upsert closes the gap permanently.

## Scope

### In scope

- An `syncSystemSkills(db)` helper that upserts all `SYSTEM_SKILLS` rows on
  every API startup using `ON CONFLICT DO UPDATE`.
- Invocation of that helper during API startup in `apps/api/src/index.ts`, before
  routes are registered.
- A unit test verifying the upsert is idempotent and that a changed field is
  reflected after a second call.
- Documentation of the behaviour in `docs/tech/agents/skill-authoring.md`.

### Out of scope

- Deletion of skills removed from `SYSTEM_SKILLS`. A skill's removal is a
  deliberate act that may cascade to existing agents; it will remain a
  manual migration step.
- Any changes to the worker process. The worker reads `SYSTEM_SKILLS`
  in-memory and does not query the `skills` table.
- Changes to user-authored skills (rows with a non-null `author_id`).
- Web UI changes.

## Constraints

### Must not cascade-delete agent relationships

A plain `DELETE … WHERE author_id IS NULL` + re-insert would cascade to any agent
row that references a system skill. The implementation must use `ON CONFLICT DO
UPDATE` to patch columns in place, preserving FK relationships.

### Idempotent across restarts and multi-replica deploys

Multiple API replicas may start concurrently. The upsert must be safe to run
simultaneously from several processes.

### The `0004` migration stays

The migration continues to seed fresh databases. The startup sync is a
reconciliation layer on top, not a replacement for it.

### Keep the helper testable in isolation

`syncSystemSkills` must accept a `db` argument (constructor-injected) so it can
be exercised in unit tests without starting the full API server.

## Proposed Design

### New helper: `apps/api/src/sync-system-skills.ts`

```ts
import { SYSTEM_SKILLS } from '@herobids/domain';
import { skills } from '@herobids/db';
import type { createDatabase } from '@herobids/db';

export async function syncSystemSkills(
  db: ReturnType<typeof createDatabase>,
): Promise<void> {
  for (const skill of SYSTEM_SKILLS) {
    await db
      .insert(skills)
      .values({
        id: skill.id,
        authorId: null,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        requiredTools: skill.requiredTools,
        contextRequirements: skill.contextRequirements,
        requiredGuardrails: skill.requiredGuardrails,
        capabilityFamilies: skill.capabilityFamilies,
        suggestedTickIntervalMs: skill.suggestedTickIntervalMs,
        visibility: skill.visibility,
        tags: [],
      })
      .onConflictDoUpdate({
        target: skills.id,
        set: {
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
          requiredTools: skill.requiredTools,
          contextRequirements: skill.contextRequirements,
          requiredGuardrails: skill.requiredGuardrails,
          capabilityFamilies: skill.capabilityFamilies,
          suggestedTickIntervalMs: skill.suggestedTickIntervalMs,
          visibility: skill.visibility,
          updatedAt: new Date(),
        },
      });
  }
}
```

### Call site in `apps/api/src/index.ts`

After `const db = createDatabase(...)` and before the first route registration:

```ts
import { syncSystemSkills } from './sync-system-skills.js';

// ...
await syncSystemSkills(db);
app.log.info('System skills synced');
```

## Plan

1. **Create `apps/api/src/sync-system-skills.ts`**
   Implement `syncSystemSkills(db)` exactly as shown above.
   Dependency: none.

2. **Call `syncSystemSkills` in `apps/api/src/index.ts`**
   Add the import and `await syncSystemSkills(db)` immediately after the `db`
   constant is created, before any route registration.
   Dependency: step 1.

3. **Write a unit test `apps/api/src/sync-system-skills.test.ts`**
   Using an in-memory or real DB (same pattern as `skills.test.ts`):
   - Call `syncSystemSkills` twice; assert the row count equals `SYSTEM_SKILLS.length`.
   - Mutate one column value, call again, assert the DB row reflects the new value
     (verifies `DO UPDATE`, not `DO NOTHING`).
   Dependency: step 1.

4. **Update `docs/tech/agents/skill-authoring.md`**
   Add a section explaining that system skills in `SYSTEM_SKILLS` are automatically
   synced to the database on every API startup, so code changes take effect on the
   next deploy/restart without a manual migration or DB operation.
   Dependency: steps 1–3 complete and verified.

5. **Remove the now-redundant `onConflictDoNothing` branch from `truncateAll`**
   in `apps/api/src/__tests__/functional/helpers.ts`
   Replace with a call to `syncSystemSkills(db)` so the test helper and the
   production path stay in sync.
   Dependency: steps 1–3.

## Verification

- `pnpm lint` passes with no type errors.
- `pnpm test` passes, including the existing `truncate-reseed-skills` functional test.
- The new unit test in step 3 passes.
- On a running dev environment: change one `instructions` string in `SYSTEM_SKILLS`,
  restart the API, and confirm the DB row is updated via `GET /skills`.

## Documentation

Update `docs/tech/agents/skill-authoring.md` (step 4) with:

> **System skill deployment**
>
> `SYSTEM_SKILLS` in `packages/domain/src/skills.ts` is the single source of
> truth for all platform-owned skills. Every time the API starts it upserts each
> entry into the `skills` table (`author_id = NULL`). Changes to instructions,
> tool lists, guardrails, or any other field take effect on the next
> deploy/restart — no migration or manual DB operation is needed.
>
> Removing a skill from `SYSTEM_SKILLS` does **not** delete the DB row
> automatically (to avoid cascading agent breakage). Removal requires a manual
> migration.

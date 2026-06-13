# 011 — API startup crash: skill revision duplicate key on re-deploy

- **Status:** FIXED (applied 2026-06-13)
- **Severity:** High
- **Date:** 2026-06-13
- **Summary:** `herobids-api-1` container exited unhealthy on every `docker compose up` because the skill-seeding loop crashed with a PostgreSQL unique constraint violation (`uq_skill_revisions_skill_version`).

## Root Cause

During API startup, `skillsRoutes` seeds system skills by inserting into `skill_revisions` with:

```typescript
const revisionId = `${skill.id}:system:1`;
```

The upsert used `onConflictDoUpdate({ target: skillRevisions.id })` — meaning it only updates if a row with that **exact `id`** already exists.

On a fresh deployment the database already contained a `skill_revisions` row for `(skill_id=bot-management, version=1)` created with a **different** `id` (e.g., from a prior UUID-based seeding run or a different id format). The new insert tried a fresh `id` (`bot-management:system:1`), found no PK conflict, but then hit the `uq_skill_revisions_skill_version` unique constraint on `(skill_id, version)` → **crash**.

## Fix

Before generating the revision ID, query for any existing `(skill_id, version=1)` row and reuse its `id`. Only fall back to the canonical `${skill.id}:system:1` format if no row exists:

```typescript
const [existingRevision] = await db
  .select({ id: skillRevisions.id })
  .from(skillRevisions)
  .where(and(eq(skillRevisions.skillId, skill.id), eq(skillRevisions.version, 1)))
  .limit(1);
const revisionId = existingRevision?.id ?? `${skill.id}:system:1`;
```

This makes the seed loop fully idempotent regardless of which ID format was used in a previous deployment.

## Files Changed

- `apps/api/src/routes/skills.ts` — `skillsRoutes` seed loop, line ~477

## Verification

- `pnpm lint` passes (no TypeScript errors).
- Container should start cleanly on next `docker compose up` / `build-and-run.sh`.

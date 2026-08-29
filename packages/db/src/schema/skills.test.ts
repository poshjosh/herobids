/**
 * Schema & migration tests for the `slug` column added to the `skills` table.
 *
 * Migration 0065 adds:
 *  - A nullable `slug` text column
 *  - Backfill for system skills: 'system/<kebab-name>'
 *  - Backfill for user-authored skills: '<username>/<kebab-name>'
 *  - A partial unique index `idx_skills_slug` WHERE slug IS NOT NULL
 *  - NOT NULL constraint after backfill
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/* ── Source file under test ──────────────────────────────────── */

const schemaSource = readFileSync(
  resolve(new URL(import.meta.url).pathname, '../skills.ts'),
  'utf-8',
);

/* ── Migration file under test ───────────────────────────────── */

const migrationPath = resolve(
  new URL(import.meta.url).pathname,
  '../../../drizzle/0065_add_skills_slug.sql',
);

describe('skills schema — slug column', () => {
  it('defines a slug text column with notNull', () => {
    // The slug column must exist as a NOT NULL text column.
    // The migration adds it nullable, backfills, then sets NOT NULL.
    // The schema reflects the final post-migration state.
    expect(schemaSource).toMatch(/slug:\s*text\('slug'\)\.notNull\(\)/);
  });

  it('imports uniqueIndex from drizzle-orm/pg-core', () => {
    // uniqueIndex is required for the partial unique index on slug.
    expect(schemaSource).toContain('uniqueIndex');
  });

  it('defines idx_skills_slug as a uniqueIndex on slug', () => {
    // The partial unique index ensures no two skills share the same slug
    // while allowing NULLs during the backfill transition window.
    expect(schemaSource).toContain("uniqueIndex('idx_skills_slug').on(t.slug)");
  });

  it('applies a WHERE clause for the partial unique index', () => {
    // The partial index only covers rows where slug IS NOT NULL,
    // matching the migration's CREATE UNIQUE INDEX … WHERE "slug" IS NOT NULL.
    // Post-migration this is a safety net (column is NOT NULL), but retained
    // to match the migration-created index exactly.
    expect(schemaSource).toMatch(/uniqueIndex\('idx_skills_slug'\)\.on\(t\.slug\)\.where\(/);
  });
});

describe('skills schema — migration 0065_add_skills_slug', () => {
  it('migration SQL file exists', () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  // Read migration only when it exists (guarded by the test above).
  const migrationSql = existsSync(migrationPath)
    ? readFileSync(migrationPath, 'utf-8')
    : '';

  it('adds the slug column to the skills table', () => {
    expect(migrationSql).toContain('ALTER TABLE "skills" ADD COLUMN "slug" text');
  });

  it('backfills system skills with system/ prefix', () => {
    // System skills (author_id IS NULL) should be addressed as 'system/<kebab-name>'.
    expect(migrationSql).toMatch(/UPDATE\s+"skills"\s+SET\s+"slug"\s*=\s*'system\/'/);
    expect(migrationSql).toContain('WHERE "author_id" IS NULL');
  });

  it('backfills user-authored skills with username prefix', () => {
    // User-authored skills join on the users table and use '<username>/<kebab-name>'.
    expect(migrationSql).toContain('FROM "users" u');
    expect(migrationSql).toContain('"skills"."author_id" = u."id"');
  });

  it('backfill uses LOWER(REPLACE(...)) for kebab-case transformation', () => {
    // Both backfill statements must lowercase and replace spaces with hyphens
    // to produce valid kebab-case slugs.
    expect(migrationSql).toContain("LOWER(REPLACE(");
  });

  it('adds column before backfill (correct ordering)', () => {
    // The ADD COLUMN must precede the UPDATE statements —
    // you cannot backfill a column that does not exist yet.
    const addColumnPos = migrationSql.indexOf('ADD COLUMN "slug"');
    const backfillPos = migrationSql.indexOf('UPDATE "skills" SET "slug"');
    expect(addColumnPos).toBeGreaterThan(-1);
    expect(backfillPos).toBeGreaterThan(-1);
    expect(backfillPos).toBeGreaterThan(addColumnPos);
  });

  it('creates the partial unique index idx_skills_slug', () => {
    expect(migrationSql).toContain('CREATE UNIQUE INDEX "idx_skills_slug"');
    expect(migrationSql).toContain('WHERE "slug" IS NOT NULL');
  });

  it('sets slug to NOT NULL after backfill', () => {
    expect(migrationSql).toContain('ALTER TABLE "skills" ALTER COLUMN "slug" SET NOT NULL');
  });

  it('applies NOT NULL after the unique index (correct ordering)', () => {
    // The partial unique index must exist before the NOT NULL constraint
    // is enforced, so the ordering in the migration matters.
    const indexPos = migrationSql.indexOf('CREATE UNIQUE INDEX "idx_skills_slug"');
    const notNullPos = migrationSql.indexOf('ALTER TABLE "skills" ALTER COLUMN "slug" SET NOT NULL');
    expect(indexPos).toBeGreaterThan(-1);
    expect(notNullPos).toBeGreaterThan(-1);
    expect(notNullPos).toBeGreaterThan(indexPos);
  });
});

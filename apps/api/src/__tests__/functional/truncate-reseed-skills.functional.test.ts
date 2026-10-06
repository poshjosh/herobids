/**
 * Integration test: truncate-and-reseed preserves the current skill contract.
 *
 * After truncateAll() runs, the skills table must contain exactly the current
 * set of system skills with requiredTools, contextRequirements, and
 * requiredGuardrails that mirror the live SkillDefinition constants in
 * packages/domain/src/skills.ts. (Phase 4 removed the built-in trading skills.)
 *
 * Requires DATABASE_URL and REDIS_URL.  Skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SKIP, buildApp, truncateAll } from './helpers.js';
import { sql } from 'drizzle-orm';
import { skills } from '@herobids/db';
import { WEB_ACCESS_SKILL, SYSTEM_SKILLS } from '@herobids/domain';

describe.skipIf(SKIP)('Truncate-and-reseed skill contract', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ctx = await buildApp();
  }, 30_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.redisClient.quit();
    await ctx.lifecycleQueue.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.db);
  });

  async function fetchSkills() {
    const rows = await ctx.db
      .select()
      .from(skills)
      .orderBy(skills.createdAt);
    return rows;
  }

  it('reseeds all system skills after truncation', async () => {
    const skillRows = await fetchSkills();
    expect(skillRows.length).toBe(SYSTEM_SKILLS.length);
    const ids = skillRows.map((s) => s.id).sort();
    expect(ids).toEqual(SYSTEM_SKILLS.map((s) => s.id).sort());
  });

  // Phase 4 (D21/EC-1): the built-in trading, bot-management and risk-monitoring
  // skills were removed from the domain, so they are no longer reseeded. The
  // tool-surface contract is now validated against a remaining system skill.

  it('web-access reseeds with the correct tool surface', async () => {
    const [skill] = await ctx.db
      .select()
      .from(skills)
      .where(sql`${skills.id} = 'web-access'`);

    expect(skill).toBeDefined();
    expect(skill!.id).toBe('web-access');
    expect(skill!.authorId).toBeNull();
    expect(skill!.publicationStatus).toBe('published');
    expect(skill!.instructions).toBe(WEB_ACCESS_SKILL.instructions);

    const tools = skill!.requiredTools as string[];
    expect(new Set(tools)).toEqual(new Set(WEB_ACCESS_SKILL.requiredTools));

    const guardrails = skill!.requiredGuardrails as string[];
    expect(new Set(guardrails)).toEqual(new Set(WEB_ACCESS_SKILL.requiredGuardrails));
  });

  // WP7 (D8): the `task-management` system skill was removed; its task and
  // reminder tools moved into the auto-injected base skill, so there is no
  // longer a task-management row to reseed.
  it('does not reseed a task-management skill', async () => {
    const rows = await ctx.db
      .select()
      .from(skills)
      .where(sql`${skills.id} = 'task-management'`);

    expect(rows).toHaveLength(0);
  });

  it('is idempotent — calling truncateAll twice yields the same skills', async () => {
    await truncateAll(ctx.db);
    const first = await fetchSkills();

    await truncateAll(ctx.db);
    const second = await fetchSkills();

    expect(second.length).toBe(first.length);
    expect(second.map((s) => s.id).sort()).toEqual(first.map((s) => s.id).sort());
  });
});

describe.skipIf(SKIP)('Startup sync — system skills present before first request', () => {
  /**
   * Verifies that buildApp() (which mirrors the index.ts startup sequence)
   * guarantees system skills exist in the DB immediately after bootstrap —
   * without any truncateAll() reseed step. This proves that syncSystemSkills()
   * runs as part of the startup path, not as a side-effect of route registration.
   */
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ctx = await buildApp();
  }, 30_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.redisClient.quit();
    await ctx.lifecycleQueue.close();
  });

  it('system skills exist immediately after buildApp() without a reseed', async () => {
    const rows = await ctx.db.select().from(skills);
    const systemSkillIds = rows.filter((s) => s.authorId === null).map((s) => s.id).sort();
    expect(systemSkillIds).toEqual(SYSTEM_SKILLS.map((s) => s.id).sort());
  });
});

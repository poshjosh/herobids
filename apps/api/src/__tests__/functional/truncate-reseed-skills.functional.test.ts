/**
 * Integration test: truncate-and-reseed preserves the current skill contract.
 *
 * After truncateAll() runs, the skills table must contain exactly the six
 * system skills with requiredTools, contextRequirements, and requiredGuardrails
 * that mirror the live SkillDefinition constants in packages/domain/src/skills.ts.
 *
 * Requires DATABASE_URL and REDIS_URL.  Skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SKIP, buildApp, truncateAll } from './helpers.js';
import { sql } from 'drizzle-orm';
import { skills } from '@herobids/db';
import { BOT_MANAGEMENT_SKILL, TRADING_SKILL, RISK_MONITORING_SKILL, WEB_ACCESS_SKILL, TASK_MANAGEMENT_SKILL, SYSTEM_SKILLS } from '@herobids/domain';

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

  it('bot-management has the full management tool surface', async () => {
    const [skill] = await ctx.db
      .select()
      .from(skills)
      .where(sql`${skills.id} = 'bot-management'`);

    expect(skill).toBeDefined();
    expect(skill!.id).toBe('bot-management');
    expect(skill!.authorId).toBeNull();
    expect(skill!.publicationStatus).toBe('published');
    expect(skill!.instructions).toBe(BOT_MANAGEMENT_SKILL.instructions);

    const tools = skill!.requiredTools as string[];
    // Must include all management tools — no more, no less (order-independent)
    const expectedTools = new Set([
      'create_bot',
      'stop_bot',
      'start_bot',
      'adjust_bot_config',
      'list_bots',
      'get_bot_status',
      'get_analytics',
      'list_positions',
      'send_message',
    ]);
    expect(new Set(tools)).toEqual(expectedTools);

    // submit_decision must NOT be in bot-management (it belongs to the trading skill)
    expect(tools).not.toContain('submit_decision');

    const contexts = skill!.contextRequirements as string[];
    expect(contexts).toContain('bot_statuses');
    expect(contexts).toContain('positions');
    expect(contexts).toContain('costs');

    const guardrails = skill!.requiredGuardrails as string[];
    expect(guardrails).toContain('token-budget');
    expect(guardrails).toContain('daily-loss');
    expect(guardrails).toContain('bot-limit');
  });

  it('trading skill has the correct direct-trading tool set', async () => {
    const [skill] = await ctx.db
      .select()
      .from(skills)
      .where(sql`${skills.id} = 'trading'`);

    expect(skill).toBeDefined();
    expect(skill!.id).toBe('trading');
    expect(skill!.authorId).toBeNull();
    expect(skill!.publicationStatus).toBe('published');
    expect(skill!.instructions).toBe(TRADING_SKILL.instructions);

    const tools = skill!.requiredTools as string[];
    const expectedTools = new Set([
      'submit_decision',
      'list_positions',
      'get_analytics',
      'check_regime',
      'search_tokens',
      'discover_tokens',
      'get_funding_rates',
      'get_market_overview',
      'get_price',
      'watch_token',
      'list_watches',
      'remove_watch',
      'check_watches',
    ]);
    expect(new Set(tools)).toEqual(expectedTools);

    const contexts = skill!.contextRequirements as string[];
    expect(contexts).toContain('positions');
    expect(contexts).toContain('fills');
    expect(contexts).toContain('analytics');
    expect(contexts).toContain('costs');

    const guardrails = skill!.requiredGuardrails as string[];
    expect(guardrails).toContain('token-budget');
    expect(guardrails).toContain('daily-loss');
  });

  it('risk-monitoring includes list_positions and get_analytics', async () => {
    const [skill] = await ctx.db
      .select()
      .from(skills)
      .where(sql`${skills.id} = 'risk-monitoring'`);

    expect(skill).toBeDefined();
    expect(skill!.id).toBe('risk-monitoring');
    expect(skill!.authorId).toBeNull();
    expect(skill!.publicationStatus).toBe('published');
    expect(skill!.instructions).toBe(RISK_MONITORING_SKILL.instructions);

    const tools = skill!.requiredTools as string[];
    const expectedTools = new Set([
      'send_message',
      'publish_artifact',
      'list_positions',
      'get_analytics',
      'get_price',
      'watch_token',
      'list_watches',
      'remove_watch',
      'check_watches',
    ]);
    expect(new Set(tools)).toEqual(expectedTools);

    const contexts = skill!.contextRequirements as string[];
    expect(contexts).toContain('positions');
    expect(contexts).toContain('fills');
    expect(contexts).toContain('analytics');

    const guardrails = skill!.requiredGuardrails as string[];
    expect(guardrails).toContain('token-budget');
    expect(guardrails).toContain('daily-loss');
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

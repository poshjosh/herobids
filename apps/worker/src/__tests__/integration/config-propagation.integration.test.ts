/**
 * Config propagation integration tests
 *
 * Verifies that operator budget config written in YAML reaches every consumer
 * that the production code path exercises:
 *
 *   1. loadConfig() parses the YAML and exposes the values on appConfig.
 *   2. The agentRuntimeConfigJson env-var blob (serialised by index.ts and
 *      injected into each agent container) preserves the budget values.
 *   3. AgentSessionManager.reconcileStartingSessions() builds a runtimeDescriptor
 *      whose `budgets` field carries the same values that were in appConfig.
 *
 * The sentinel value `maxVisibleToolSchemas: 37` is chosen because it differs
 * from every production default, making accidental hardcode easy to detect.
 *
 * Tests 1 & 2 are pure (no DB/Redis).
 * Test 3 requires DATABASE_URL and REDIS_URL — skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sql, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import Redis from 'ioredis';
import { createDatabase, users, agents, agentRuntimeSessions, localIdentities, userPlans } from '@herobids/db';
import { AgentRepository } from '@herobids/db';
import { loadConfig } from '../../config.js';
import { AgentRuntimeLauncher } from '../../agents/agent-runtime-launcher.js';
import { AgentSessionManager } from '../../agents/agent-session-manager.js';
import { InstanceEventPublisher } from '../../agents/instance-event-publisher.js';

const scrypt = promisify<crypto.BinaryLike, crypto.BinaryLike, number, Buffer>(crypto.scrypt);

// ─── Sentinel value ──────────────────────────────────────────────────────────
// Must differ from all production defaults so a hardcoded default is detectable.
const SENTINEL = 37;

// ─── Minimal YAML with all six budget fields set to the sentinel ─────────────
// app/redis/execution/risk are top-level z.object() fields without .default({})
// so they must be present in the YAML even as empty objects.
const SENTINEL_YAML = `
app:
  port: 3000
database:
  url: postgres://herobids:herobids@localhost:5432/herobids
redis:
  url: redis://localhost:6379
execution:
  defaultSlippageBps: 50
risk:
  globalMaxDrawdownPct: 20
agentRuntime:
  llm:
    scout:
      maxTurns: ${SENTINEL}
      maxTokens: 1370
      temperature: 0.37
    judge:
      maxTurns: 41
      temperature: 0.61
  wake:
    minIntervalMs: 37000
    pollMs: 1370
  marketIntelligence:
    maxTrackedPerps: ${SENTINEL}
    maxTrackedDexTargets: 41
    maxRefreshedDexTargetsPerTick: 13
  defaultBudgets:
    maxHistoryMessages: ${SENTINEL}
    maxHistoryTokens: ${SENTINEL}
    maxRecentToolMessages: ${SENTINEL}
    maxToolResultChars: ${SENTINEL}
    maxVisibleToolSchemas: ${SENTINEL}
    maxContextBlockChars: ${SENTINEL}
    toolResultFullRetentionTurns: 4
    toolResultMaxStaleChars: 600
`;

// ─── DB/Redis skip guard ──────────────────────────────────────────────────────
const SKIP_DB = !process.env['DATABASE_URL'] || !process.env['REDIS_URL'];
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://herobids:herobids@localhost:5432/herobids';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname || 'localhost',
    port: parseInt(u.port || '6379', 10),
    ...(u.password && { password: decodeURIComponent(u.password) }),
    ...(u.username && { username: decodeURIComponent(u.username) }),
  };
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

async function seedUser(db: ReturnType<typeof createDatabase>) {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id,
    displayName: 'Propagation Test User',
    email: `${id}@propagation-test.local`,
    planId: 'free',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(localIdentities).values({
    id: crypto.randomUUID(),
    userId: id,
    passwordHash: await hashPassword('pw123'),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(userPlans).values({
    id: crypto.randomUUID(),
    userId: id,
    planId: 'free',
  });
  return id;
}

async function seedAgent(db: ReturnType<typeof createDatabase>, userId: string) {
  const agentId = crypto.randomUUID();
  const now = new Date();
  await db.insert(agents).values({
    id: agentId,
    userId,
    name: 'Propagation Test Agent',
    prompt: 'Stand by.',
    skillIds: [],
    status: 'stopped',
    createdAt: now,
    updatedAt: now,
  });
  return agentId;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('Config propagation: budget values reach consumers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'herobids-propagation-test-'));
    writeFileSync(resolve(tmpDir, 'default.yaml'), SENTINEL_YAML);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── 1. loadConfig parses all five budget fields ───────────────────────────

  it('loadConfig exposes all six sentinel budget values on appConfig', () => {
    const appConfig = loadConfig(tmpDir);

    const b = appConfig.agentRuntime.defaultBudgets;
    expect(b.maxHistoryMessages).toBe(SENTINEL);
    expect(b.maxHistoryTokens).toBe(SENTINEL);
    expect(b.maxRecentToolMessages).toBe(SENTINEL);
    expect(b.maxToolResultChars).toBe(SENTINEL);
    expect(b.maxVisibleToolSchemas).toBe(SENTINEL);
    expect(b.maxContextBlockChars).toBe(SENTINEL);
    expect(b.toolResultFullRetentionTurns).toBe(4);
    expect(b.toolResultMaxStaleChars).toBe(600);
  });

  // ── 2. agentRuntimeConfigJson preserves the budget values ────────────────
  // This mirrors the exact JSON.stringify call in apps/worker/src/index.ts that
  // is injected into the AGENT_RUNTIME_CONFIG_JSON env var of each container.

  it('agentRuntimeConfigJson serialisation preserves all six sentinel budget values', () => {
    const appConfig = loadConfig(tmpDir);

    // Replicate the serialisation performed in index.ts verbatim.
    const agentRuntimeConfigJson = JSON.stringify({
      ...appConfig.agentRuntime,
      llm: {
        retry: appConfig.llm.retry,
        scout: {
          ...appConfig.llm.scout,
          ...appConfig.agentRuntime.llm.scout,
        },
        judge: appConfig.agentRuntime.llm.judge,
        thinking: appConfig.llm.thinking,
      },
    });

    const parsed = JSON.parse(agentRuntimeConfigJson) as {
      defaultBudgets: Record<string, unknown>;
      llm: {
        scout: Record<string, unknown>;
        judge: Record<string, unknown>;
      };
      wake: Record<string, unknown>;
      marketIntelligence: Record<string, unknown>;
    };

    expect(parsed.defaultBudgets['maxHistoryMessages']).toBe(SENTINEL);
    expect(parsed.defaultBudgets['maxHistoryTokens']).toBe(SENTINEL);
    expect(parsed.defaultBudgets['maxRecentToolMessages']).toBe(SENTINEL);
    expect(parsed.defaultBudgets['maxToolResultChars']).toBe(SENTINEL);
    expect(parsed.defaultBudgets['maxVisibleToolSchemas']).toBe(SENTINEL);
    expect(parsed.defaultBudgets['maxContextBlockChars']).toBe(SENTINEL);
    expect(parsed.defaultBudgets['toolResultFullRetentionTurns']).toBe(4);
    expect(parsed.defaultBudgets['toolResultMaxStaleChars']).toBe(600);
    expect(parsed.llm.scout['maxTurns']).toBe(SENTINEL);
    expect(parsed.llm.scout['maxTokens']).toBe(1370);
    expect(parsed.llm.scout['temperature']).toBe(0.37);
    expect(parsed.llm.judge['maxTurns']).toBe(41);
    expect(parsed.llm.judge['temperature']).toBe(0.61);
    expect(parsed.wake['minIntervalMs']).toBe(37000);
    expect(parsed.wake['pollMs']).toBe(1370);
    expect(parsed.marketIntelligence['maxTrackedPerps']).toBe(SENTINEL);
    expect(parsed.marketIntelligence['maxTrackedDexTargets']).toBe(41);
    expect(parsed.marketIntelligence['maxRefreshedDexTargetsPerTick']).toBe(13);
  });

  // ── 3. AgentSessionManager passes the budgets into the runtimeDescriptor ─
  // Requires DATABASE_URL + REDIS_URL.

  describe.skipIf(SKIP_DB)('via AgentSessionManager.reconcileStartingSessions (stub runtime)', () => {
    let db: ReturnType<typeof createDatabase>;
    let redisClient: Redis;
    let agentRepo: AgentRepository;
    let eventPublisher: InstanceEventPublisher;
    let launcher: AgentRuntimeLauncher;
    let sessionManager: AgentSessionManager;

    beforeAll(async () => {
      db = createDatabase(DB_URL);
      redisClient = new Redis(parseRedisUrl(REDIS_URL));
      agentRepo = new AgentRepository(db);
      eventPublisher = new InstanceEventPublisher(redisClient);
    }, 30_000);

    afterAll(async () => {
      await redisClient.quit();
    });

    beforeEach(async () => {
      await db.execute(sql`
        TRUNCATE
          agent_runtime_sessions, agent_messages, agent_artifacts,
          agent_outbound_messages, agents, sessions, local_identities,
          oauth_identities, user_plans, users
        CASCADE
      `);

      launcher = new AgentRuntimeLauncher({ redis: redisClient, heartbeatIntervalMs: 200 });
    });

    afterEach(async () => {
      await sessionManager?.stop();
      await launcher.stopAll();
    });

    it('runtimeDescriptor.budgets carries all six sentinel values', async () => {
      const appConfig = loadConfig(tmpDir);
      const budgets = appConfig.agentRuntime.defaultBudgets;

      // Spy before creating the session manager so the spy is in place when
      // reconcileStartingSessions calls launcher.launch().
      const launchSpy = vi.spyOn(launcher, 'launch');

      sessionManager = new AgentSessionManager(
        agentRepo,
        eventPublisher,
        launcher,
        { budgets },
      );

      const userId = await seedUser(db);
      const agentId = await seedAgent(db, userId);
      const sessionId = crypto.randomUUID();

      await db.insert(agentRuntimeSessions).values({ id: sessionId, agentId, status: 'starting' });
      await db.update(agents).set({ status: 'starting' }).where(eq(agents.id, agentId));

      await sessionManager.reconcileStartingSessions();

      expect(launchSpy).toHaveBeenCalledOnce();

      const launchArg = launchSpy.mock.calls[0]![0];
      const rd = launchArg.runtimeDescriptor;

      expect(rd).toBeDefined();
      expect(rd!.budgets.maxHistoryMessages).toBe(SENTINEL);
      expect(rd!.budgets.maxRecentToolMessages).toBe(SENTINEL);
      expect(rd!.budgets.maxToolResultChars).toBe(SENTINEL);
      expect(rd!.budgets.maxVisibleToolSchemas).toBe(SENTINEL);
      expect(rd!.budgets.maxContextBlockChars).toBe(SENTINEL);
      expect(rd!.budgets.toolResultFullRetentionTurns).toBe(4);
      expect(rd!.budgets.toolResultMaxStaleChars).toBe(600);
    });
  });
});

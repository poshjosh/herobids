/**
 * Shared helpers for functional API tests.
 *
 * These tests require a live DATABASE_URL and REDIS_URL.  They are skipped
 * automatically when those env vars are absent.
 */

import Fastify from 'fastify';
import { sql } from 'drizzle-orm';
import { createDatabase, skills as skillsTable } from '@herobids/db';
import { authPlugin } from '../../plugins/auth.js';
import { authRoutes } from '../../routes/auth.js';
import { agentRoutes } from '../../routes/agents.js';
import { botRoutes } from '../../routes/bots.js';
import { credentialRoutes } from '../../routes/credentials.js';
import { connectionRoutes } from '../../routes/connections.js';
import { capabilityRoutes } from '../../routes/capabilities/index.js';
import { eventsRoutes } from '../../routes/events.js';
import { agentInteractivityRoutes, telegramWebhookHandler } from '../../routes/agent-interactivity.js';
import { analyticsRoutes } from '../../routes/analytics.js';
import { aiRoutes } from '../../routes/ai.js';
import { skillsRoutes } from '../../routes/skills.js';
import { datasetRoutes } from '../../routes/datasets.js';
import { exportRoutes } from '../../routes/exports.js';
import { setupRoutes } from '../../routes/setup.js';
import type { AuthConfig } from '@herobids/domain';
import { BOT_MANAGEMENT_SKILL, TRADING_SKILL, RISK_MONITORING_SKILL, LlmRuntimeConfigSchema, SYSTEM_SKILLS } from '@herobids/domain';
import { Queue } from 'bullmq';

export const SKIP = !process.env['DATABASE_URL'] || !process.env['REDIS_URL'];
export const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://herobids:herobids@localhost:5432/herobids';
export const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

export const TEST_JWT_SECRET = 'test-functional-secret-at-least-32-chars!!';

export function makeAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    publicBaseUrl: 'http://localhost:3000',
    frontendOrigin: 'http://localhost:5173',
    jwtSecret: TEST_JWT_SECRET,
    jwtTtlSecs: 3600,
    exchangeCodeTtlSecs: 60,
    googleClientId: 'test-google-client-id',
    googleClientSecret: 'test-google-client-secret',
    secureCookie: false,
    adminUserIds: [],
    ...overrides,
  };
}

export function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname || 'localhost',
    port: parseInt(u.port || '6379', 10),
    ...(u.password && { password: decodeURIComponent(u.password) }),
    ...(u.username && { username: decodeURIComponent(u.username) }),
  };
}

/** Build a fully wired Fastify app for functional testing. */
export async function buildApp() {
  const db = createDatabase(DB_URL);
  const redisConn = parseRedisUrl(REDIS_URL);
  const lifecycleQueue = new Queue('trading-instance-lifecycle', { connection: redisConn });

  const app = Fastify({ logger: false });
  const authConfig = makeAuthConfig();

  await authPlugin(app, { config: authConfig, db });

  // Import Redis client lazily to avoid import side effects
  const { Redis } = await import('ioredis');
  const redisClient = new Redis(redisConn);

  await eventsRoutes(app, authConfig, () => {
    const subscriber = new Redis(redisConn);
    subscriber.on('error', (err: Error) => app.log.error({ err }, 'Events subscriber error'));
    return {
      subscribe: async (channel: string, callback: (message: string) => void) => {
        subscriber.on('message', (_channel: string, message: string) => {
          if (_channel === channel) {
            callback(message);
          }
        });
        await subscriber.subscribe(channel);
      },
      unsubscribe: async (channel: string) => {
        await subscriber.unsubscribe(channel);
        subscriber.disconnect();
      },
    };
  });

  await credentialRoutes(app, lifecycleQueue, db);

  await authRoutes(app, authConfig, db, redisClient, 'free');
  await agentRoutes(app, db);
  await connectionRoutes(app, db, redisClient);
  await capabilityRoutes(app, db, { defaultPlanId: 'free', plans: {} } as any, redisClient);
  await botRoutes(app, lifecycleQueue, db, { defaultPlanId: 'free', plans: {} } as any);

  // Telegram webhook (unauthenticated, no token in test → returns 501)
  await telegramWebhookHandler(app);
  await agentInteractivityRoutes(app, db, redisClient);

  await analyticsRoutes(app, db);

  const stubLlmConfig = LlmRuntimeConfigSchema.parse({
    provider: 'openai',
    model: 'gpt-4o',
    maxTokens: 4096,
    timeoutMs: 60_000,
    tickIntervalMs: 900_000,
    heartbeatIntervalMs: 5_000,
  });
  await aiRoutes(app, db, stubLlmConfig, redisClient);

  await skillsRoutes(app, db);
  await datasetRoutes(app, db, redisClient);
  await exportRoutes(app, db);

  await setupRoutes(app, db);

  await app.ready();

  return { app, db, redisClient, lifecycleQueue };
}

/** Truncate all test tables in FK-safe order. */
export async function truncateAll(db: ReturnType<typeof createDatabase>) {
  await db.execute(sql`
    TRUNCATE
      capability_grant_audit,
      capability_grants,
      trading_bindings,
      connections,
      user_credentials,
      venue_accounts,
      agent_credentials,
      bots,
      agent_runtime_sessions,
      agent_messages,
      agent_artifacts,
      agent_outbound_messages,
      decisions,
      agents,
      sessions,
      skills,
      local_identities,
      oauth_identities,
      user_plans,
      users
    CASCADE
  `);

  // Re-seed system skills after truncation (authorId = null = platform-owned).
  // Source instructions and tool sets from the live domain constants to keep
  // them in sync with what the functional contract tests assert.
  for (const skill of SYSTEM_SKILLS) {
    await db.insert(skillsTable).values({
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
    }).onConflictDoNothing();
  }
}

/** Register a test user and return the auth token. */
export async function registerUser(
  app: ReturnType<typeof Fastify>,
  email = 'test@functional.test',
  password = 'testpassword123',
  displayName = 'Test User',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password, displayName },
  });

  if (res.statusCode !== 201) {
    throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  }

  const body = res.json() as { token: string };
  return body.token;
}

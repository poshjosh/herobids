/**
 * Shared helpers for functional API tests.
 *
 * These tests require a live DATABASE_URL and REDIS_URL.  They are skipped
 * automatically when those env vars are absent.
 */

import Fastify from 'fastify';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@herobids/db';
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
import type { AuthConfig, RuntimeBudgetPolicy } from '@herobids/domain';
import { loadProvidersConfig } from '@herobids/domain';
import { LlmRuntimeConfigSchema } from '@herobids/domain';
import { syncSystemSkills } from '../../sync-system-skills.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_BUDGETS: RuntimeBudgetPolicy = {
  maxHistoryMessages: 20,
  maxHistoryTokens: 40_000,
  maxRecentToolMessages: 6,
  maxToolResultChars: 4_000,
  maxVisibleToolSchemas: 64,
  maxContextBlockChars: 4_000,
};
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
  // Clear LLM API key env vars to prevent them from leaking into the test
  // environment. The analytics/AI functional tests expect 503 (no_ai_provider)
  // when no provider keys are set. If the user's shell has these keys set,
  // getAvailableProviders picks them up and returns 200/502 instead.
  const savedLlmEnv: Record<string, string | undefined> = {};
  for (const key of ['LLM_API_KEY', 'LLM_API_KEY_OPENAI', 'LLM_API_KEY_OPENROUTER', 'LLM_API_KEY_OLLAMA']) {
    savedLlmEnv[key] = process.env[key];
    delete process.env[key];
  }

  const db = createDatabase(DB_URL);
  const redisConn = parseRedisUrl(REDIS_URL);
  const lifecycleQueue = new Queue('trading-instance-lifecycle', { connection: redisConn });

  const app = Fastify({ logger: false });
  const authConfig = makeAuthConfig();
  const testPlansConfig = {
    defaultPlanId: 'free',
    plans: {
      free: {
        entitlements: {
          skills: {
            canCreatePrivateSkills: false,
            canViewMarketplaceSkills: true,
            canPublishToMarketplace: true,
            autoPublishNonDraftSkills: true,
            canPriceSkills: false,
            canLikeMarketplaceSkills: true,
          },
          agents: {
            canViewOwnPrompts: true,
          },
          limits: {
            maxAgents: 5,
            maxBots: 5,
            maxConnections: 5,
            maxCredentials: 5,
            maxBindings: 5,
            maxVenueAccounts: 5,
            maxConcurrentBacktests: 3,
            liveEnabled: false,
          },
        },
        usage: {
          includedCreditCents: 0,
          topUpPackIds: [],
        },
      },
      prompt_hidden: {
        entitlements: {
          skills: {
            canCreatePrivateSkills: false,
            canViewMarketplaceSkills: true,
            canPublishToMarketplace: true,
            autoPublishNonDraftSkills: true,
            canPriceSkills: false,
            canLikeMarketplaceSkills: true,
          },
          agents: {
            canViewOwnPrompts: false,
          },
          limits: {
            maxAgents: 5,
            maxBots: 5,
            maxConnections: 5,
            maxCredentials: 5,
            maxBindings: 5,
            maxVenueAccounts: 5,
            maxConcurrentBacktests: 3,
            liveEnabled: false,
          },
        },
        usage: {
          includedCreditCents: 0,
          topUpPackIds: [],
        },
      },
    },
  };

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

  await authRoutes(app, authConfig, db, redisClient, 'free', testPlansConfig as any);
  await agentRoutes(app, db);
  await connectionRoutes(app, db, TEST_BUDGETS, redisClient, testPlansConfig as any);
  await capabilityRoutes(app, db, testPlansConfig as any, TEST_BUDGETS, redisClient);
  await botRoutes(app, lifecycleQueue, db, testPlansConfig as any);

  // Telegram webhook (unauthenticated, no token in test → returns 501)
  await telegramWebhookHandler(app, db, redisClient);
  await agentInteractivityRoutes(app, db, redisClient, undefined, undefined, testPlansConfig as any);

  await analyticsRoutes(app, db);

  const stubLlmConfig = LlmRuntimeConfigSchema.parse({
    provider: 'openai',
    model: 'gpt-4o',
    maxTokens: 4096,
    timeoutMs: 60_000,
    tickIntervalMs: 900_000,
    heartbeatIntervalMs: 5_000,
  });
  const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
  const MONOREPO_CONFIG_DIR = resolve(MODULE_DIR, '../../../../../config');
  const providersYaml = loadProvidersConfig(resolve(MONOREPO_CONFIG_DIR, 'providers.yaml'));
  await aiRoutes(app, db, stubLlmConfig, redisClient, providersYaml, { llm: {} } as import('@herobids/domain').AgentRuntimeConfig);

  // Sync system skills before route registration, mirroring the startup sequence
  // in apps/api/src/index.ts. This is the single canonical sync point.
  await syncSystemSkills(db);
  await skillsRoutes(app, db, testPlansConfig as any);
  await datasetRoutes(app, db, redisClient);
  await exportRoutes(app, db);

  await setupRoutes(app, db, testPlansConfig as any);

  await app.ready();

  // Restore LLM API key env vars so they don't leak between test files
  for (const [key, value] of Object.entries(savedLlmEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return { app, db, redisClient, lifecycleQueue };
}

/** Truncate all test tables in FK-safe order. */
export async function truncateAll(db: ReturnType<typeof createDatabase>) {
  await db.execute(sql`
    TRUNCATE
      connections,
      user_credentials,
      venue_accounts,
      agent_skills,
      bots,
      fills,
      positions,
      agent_runtime_sessions,
      agent_messages,
      agent_artifacts,
      agent_outbound_messages,
      skill_usage_events,
      skill_likes,
      skill_entitlements,
      skill_revisions,
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

  await syncSystemSkills(db);
}

/** Register a test user and return the auth token. */
export async function registerUser(
  app: ReturnType<typeof Fastify>,
  db: ReturnType<typeof createDatabase>,
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
  const token = body.token;

  // Set up AI model config directly in the DB so agent creation
  // doesn't require a provider in every payload.
  // We cannot use PATCH /settings/ai-model because it validates
  // against the live provider catalog (needs API keys in env).
  const { users } = await import('@herobids/db');
  const { eq } = await import('drizzle-orm');
  const userId = await getUserIdFromToken(app, token);
  await db.update(users)
    .set({
      aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  return token;
}

/** Extract the user ID from a JWT token using the /auth/me endpoint. */
async function getUserIdFromToken(app: ReturnType<typeof Fastify>, token: string): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.statusCode !== 200) {
    throw new Error(`/auth/me failed: ${res.statusCode} ${res.body}`);
  }
  return (res.json() as { id: string }).id;
}

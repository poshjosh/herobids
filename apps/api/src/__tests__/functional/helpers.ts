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
import type { TradertonClient, TradertonClientResult, InvokeToolInput, TradertonBoundaryFailureCode } from '@herobids/domain/traderton';
import { loadProvidersConfig } from '@herobids/domain/config/load-providers';
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
    loginLinkTtlSecs: 600,
    loginLinkResendCooldownSecs: 60,
    loginLinkMaxSendsPerWindow: 5,
    loginLinkWindowSecs: 3600,
    loginLinkMaxSendsPerIpWindow: 10,
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

/**
 * A stubbed Traderton REST boundary client for functional tests.
 *
 * On `consume-traderton`, trading provider-links provision their venue account
 * over the boundary (`provision_venue_account`) and the venue-account plan-limit
 * check is sourced from the boundary (`count_venue_accounts`) — herobids no
 * longer writes trading credentials/venue-accounts locally. Without a client the
 * routes fail closed (503). This stub returns scripted success so the
 * connection-dependent functional suites exercise the real post-provision local
 * write (the connection row + resolvedVenueAccountId) instead of stalling at 503.
 *
 * It faithfully mirrors the real boundary tools' success payloads:
 *   count_venue_accounts    → { count: 0 }   (under any plan limit → provisioning proceeds)
 *   provision_venue_account → { venueAccountId, venue, label }
 *   deprovision_venue_account → generic success
 *
 * BOT lifecycle (consume-traderton re-point): Traderton now owns bots. This stub
 * is a coherent in-memory test double for the bot boundary tools so the
 * bots-lifecycle suite exercises the full create → read → stop/start flow over
 * the (single) boundary client — which serves BOTH the write path
 * (create/stop/start, via `invokeBoundary`) and the owner-scoped READ path
 * (list/status, via the route's `readBoundary`, derived from the same client):
 *   create_bot           → records a bot (id, owner, status:'stopped', config), returns { botId }
 *                          paper+swap config → validation.invalid_payload failure with
 *                          details.errorCode:'execution_capability.paper_swap_not_supported'
 *   list_owner_bots      → owner-scoped summaries { id, status, strategyPreset, symbol, ... }
 *   get_owner_bot_status → owner-scoped status { ok, id, status, config, ... }; not found /
 *                          not owned → not_found.resource failure (drives the 404 + ownership cases)
 *   start_bot / stop_bot → flip the recorded status; not found / not owned → not_found.resource
 *   delete_bot           → remove the recorded bot; not found / not owned → not_found.resource;
 *                          running → validation.invalid_payload w/ details.errorCode:'bot.running' (→ 409)
 *
 * Ownership is enforced by scoping every read/mutation to `subject.ownerId`, so
 * the "rejects non-owned bot" cases are TRUE reds (404 from the owner check, not
 * from an empty local table).
 */
interface StubBot {
  id: string;
  ownerId: string;
  status: string;
  config: Record<string, unknown>;
  strategyPreset: string | null;
  symbol: string | null;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
}

function isPaperSwapConfig(config: Record<string, unknown>): boolean {
  const execMode = (config['execution'] as Record<string, unknown> | undefined)?.['mode'];
  const hasSwapAssets = config['swapAssets'] !== undefined;
  const venue = typeof config['venue'] === 'string' ? (config['venue'] as string) : undefined;
  const swapVenue = hasSwapAssets || venue === '1inch' || venue === 'jupiter';
  return execMode === 'paper' && swapVenue;
}

export function makeStubTradertonClient(): TradertonClient {
  const bots = new Map<string, StubBot>();
  // Agent-scoped evidence reads (get_agent_fills / get_agent_positions) are keyed
  // by the AGENT id from the subject actor — routes build the subject as
  // { ownerId, actor: { type: 'agent', id: agentId } } with an empty payload, so
  // the agent id is the ONLY per-agent key available to the stub.
  const agentFills = new Map<string, unknown[]>();
  const agentPositions = new Map<string, unknown[]>();
  let seq = 0;

  const ok = (payload: unknown): TradertonClientResult => ({
    kind: 'success',
    requestId: 'fn-test',
    correlationId: 'fn-test',
    payload,
  });
  const failure = (
    code: TradertonBoundaryFailureCode,
    message: string,
    details?: Record<string, unknown>,
  ): TradertonClientResult => ({
    kind: 'failure',
    requestId: 'fn-test',
    correlationId: 'fn-test',
    code,
    message,
    retryable: false,
    ...(details ? { details } : {}),
  });

  // Reproduce the REAL boundary dispatcher mapping: a tool's fault:false
  // `not_found.resource` errorCode is surfaced on the wire as the generic
  // `validation.invalid_payload` code with the original under `details.errorCode`.
  // (A top-level `not_found.resource` code would NOT exercise the route's unwrap
  // and would be a false green.)
  const notFound = (): TradertonClientResult =>
    failure('validation.invalid_payload', 'Bot not found', { errorCode: 'not_found.resource' });

  return {
    invoke: (input: InvokeToolInput): Promise<TradertonClientResult> => {
      const ownerId = input.subject.ownerId;
      const p = (input.payload ?? {}) as Record<string, unknown>;
      switch (input.toolName) {
        case 'count_venue_accounts':
          return Promise.resolve(ok({ count: 0 }));
        case 'provision_venue_account': {
          // In generate mode the boundary mints the keypair and returns the
          // public wallet ({ address, network }); manual mode returns null.
          const generate = p['generate'] as { network?: unknown } | undefined;
          const wallet = generate && typeof generate.network === 'string'
            ? { address: '0xGeneratedBoundaryWallet', network: generate.network }
            : null;
          return Promise.resolve(ok({
            venueAccountId: 'va-new',
            venue: p['venue'] ?? 'hyperliquid',
            label: p['label'] ?? 'test',
            wallet,
          }));
        }
        case 'create_bot': {
          const config = (p['config'] as Record<string, unknown> | undefined) ?? {};
          if (isPaperSwapConfig(config)) {
            return Promise.resolve(failure(
              'validation.invalid_payload',
              'paper execution mode is not supported for swap venues',
              { errorCode: 'execution_capability.paper_swap_not_supported' },
            ));
          }
          const id = `bot-${++seq}`;
          const strategy = config['strategy'] as Record<string, unknown> | undefined;
          bots.set(id, {
            id,
            ownerId,
            status: 'stopped',
            config,
            strategyPreset: typeof strategy?.['type'] === 'string' ? (strategy['type'] as string) : null,
            symbol: typeof config['symbol'] === 'string' ? (config['symbol'] as string) : null,
            createdAt: new Date().toISOString(),
            startedAt: null,
            stoppedAt: null,
          });
          return Promise.resolve(ok({ botId: id }));
        }
        case 'list_owner_bots': {
          const owned = [...bots.values()].filter((b) => b.ownerId === ownerId);
          return Promise.resolve(ok({
            bots: owned.map((b) => ({
              id: b.id,
              status: b.status,
              strategyPreset: b.strategyPreset,
              symbol: b.symbol,
              createdAt: b.createdAt,
              creatorType: 'user',
              creatorId: b.ownerId,
            })),
          }));
        }
        case 'get_owner_bot_status': {
          const id = typeof p['botId'] === 'string' ? (p['botId'] as string) : '';
          const bot = bots.get(id);
          if (!bot || bot.ownerId !== ownerId) return Promise.resolve(notFound());
          return Promise.resolve(ok({
            ok: true,
            id: bot.id,
            status: bot.status,
            strategyPreset: bot.strategyPreset,
            symbol: bot.symbol,
            config: bot.config,
            startedAt: bot.startedAt,
            stoppedAt: bot.stoppedAt,
            creatorType: 'user',
            creatorId: bot.ownerId,
          }));
        }
        // Wave A2 owner-scoped bot read-wave. Each resolves the bot owner-scoped
        // (not owned → not_found.resource, driving the 404 + ownership cases) and
        // returns the SAME payload shape Traderton's tool returns today. The
        // aggregation lives in Traderton — this double returns plausible
        // owner-scoped values, enough for the endpoints to pass through.
        case 'get_owner_bot_costs': {
          const id = typeof p['botId'] === 'string' ? (p['botId'] as string) : '';
          const bot = bots.get(id);
          if (!bot || bot.ownerId !== ownerId) return Promise.resolve(notFound());
          return Promise.resolve(ok({ ok: true, botId: id, feesByCurrency: { USDC: '0' } }));
        }
        case 'get_owner_bot_sessions': {
          const id = typeof p['botId'] === 'string' ? (p['botId'] as string) : '';
          const bot = bots.get(id);
          if (!bot || bot.ownerId !== ownerId) return Promise.resolve(notFound());
          const limit = typeof p['limit'] === 'number' ? (p['limit'] as number) : 20;
          const offset = typeof p['offset'] === 'number' ? (p['offset'] as number) : 0;
          return Promise.resolve(ok({ ok: true, botId: id, sessions: [], limit, offset }));
        }
        case 'get_owner_bot_journal_summary': {
          const id = typeof p['botId'] === 'string' ? (p['botId'] as string) : '';
          const bot = bots.get(id);
          if (!bot || bot.ownerId !== ownerId) return Promise.resolve(notFound());
          return Promise.resolve(ok({ ok: true, botId: id, tradeCount: 0, feesByCurrency: {} }));
        }
        case 'get_owner_bot_journal': {
          const id = typeof p['botId'] === 'string' ? (p['botId'] as string) : '';
          const bot = bots.get(id);
          if (!bot || bot.ownerId !== ownerId) return Promise.resolve(notFound());
          return Promise.resolve(ok({ ok: true, events: [] }));
        }
        // c4.2 export evidence reads. The bot-scoped fills/positions resolve the
        // bot owner-scoped (unowned → not_found.resource, driving the export 404),
        // then return an empty evidence array — enough for the export endpoints to
        // pass through fillsToCsv/computeReport with no rows.
        case 'get_owner_bot_fills': {
          const id = typeof p['botId'] === 'string' ? (p['botId'] as string) : '';
          const bot = bots.get(id);
          if (!bot || bot.ownerId !== ownerId) return Promise.resolve(notFound());
          return Promise.resolve(ok({ ok: true, fills: [] }));
        }
        case 'get_owner_bot_positions': {
          const id = typeof p['botId'] === 'string' ? (p['botId'] as string) : '';
          const bot = bots.get(id);
          if (!bot || bot.ownerId !== ownerId) return Promise.resolve(notFound());
          return Promise.resolve(ok({ ok: true, positions: [] }));
        }
        case 'get_owner_bot_reconciliation_events': {
          const id = typeof p['botId'] === 'string' ? (p['botId'] as string) : '';
          const bot = bots.get(id);
          if (!bot || bot.ownerId !== ownerId) return Promise.resolve(notFound());
          return Promise.resolve(ok({ ok: true, botId: id, venueAccountId: 'va-stub', events: [] }));
        }
        // Account-level owner reads are NOT bot-scoped — a user with no bots
        // yields empty evidence (the export empty-case parity).
        case 'get_owner_fills':
          return Promise.resolve(ok({ ok: true, fills: [] }));
        case 'get_owner_journal':
          return Promise.resolve(ok({ ok: true, events: [] }));
        case 'get_owner_positions':
          return Promise.resolve(ok({ ok: true, positions: [] }));
        // Agent-scoped evidence reads for the /agents/:id/export/* endpoints.
        case 'get_agent_fills': {
          const actor = input.subject.actor;
          const agentId = actor.type === 'agent' && typeof actor.id === 'string' ? actor.id : '';
          return Promise.resolve(ok({ ok: true, fills: agentFills.get(agentId) ?? [] }));
        }
        case 'get_agent_journal_events':
          return Promise.resolve(ok({ ok: true, events: [] }));
        case 'get_agent_positions': {
          const actor = input.subject.actor;
          const agentId = actor.type === 'agent' && typeof actor.id === 'string' ? actor.id : '';
          return Promise.resolve(ok({ ok: true, positions: agentPositions.get(agentId) ?? [] }));
        }
        case 'start_bot': {
          const id = typeof p['botId'] === 'string' ? (p['botId'] as string) : '';
          const bot = bots.get(id);
          if (!bot || bot.ownerId !== ownerId) return Promise.resolve(notFound());
          bot.status = 'running';
          bot.startedAt = new Date().toISOString();
          return Promise.resolve(ok({ ok: true, botId: id }));
        }
        case 'stop_bot': {
          const id = typeof p['botId'] === 'string' ? (p['botId'] as string) : '';
          const bot = bots.get(id);
          if (!bot || bot.ownerId !== ownerId) return Promise.resolve(notFound());
          bot.status = 'stopped';
          bot.stoppedAt = new Date().toISOString();
          return Promise.resolve(ok({ ok: true, botId: id }));
        }
        case 'delete_bot': {
          // Wave A1: the authoritative bot delete. Owner-scoped: a bot owned by
          // another user resolves as not_found (drives the 404). A running bot is
          // refused with the dedicated `bot.running` code — mirroring the real
          // boundary, a fault:false failure surfaces as validation.invalid_payload
          // carrying details.errorCode (the route maps that errorCode to 409).
          const id = typeof p['botId'] === 'string' ? (p['botId'] as string) : '';
          const bot = bots.get(id);
          if (!bot || bot.ownerId !== ownerId) return Promise.resolve(notFound());
          if (bot.status === 'running') {
            return Promise.resolve(failure(
              'validation.invalid_payload',
              'Cannot delete a running bot. Stop it first.',
              { errorCode: 'bot.running' },
            ));
          }
          bots.delete(id);
          return Promise.resolve(ok({ ok: true, botId: id, deleted: true }));
        }
        default:
          return Promise.resolve(ok({ ok: true }));
      }
    },
    // Test-only seeding hooks (extra properties on the stub object — the
    // TradertonClient type is NOT widened; the stub stays `as unknown as
    // TradertonClient`). Rows are the same object shape the old dropped-table
    // inserts used, with date fields as ISO strings (rehydrated to Date by
    // toFillRow/toPositionRow on the read path).
    seedAgentFills: (agentId: string, rows: unknown[]): void => {
      agentFills.set(agentId, rows);
    },
    seedAgentPositions: (agentId: string, rows: unknown[]): void => {
      agentPositions.set(agentId, rows);
    },
  } as unknown as TradertonClient & {
    seedAgentFills: (agentId: string, rows: unknown[]) => void;
    seedAgentPositions: (agentId: string, rows: unknown[]) => void;
  };
}

/** Build a fully wired Fastify app for functional testing. */
export async function buildApp() {
  // Clear LLM API key env vars to prevent them from leaking into the test
  // environment, then set a dummy OpenRouter key so getAvailableProviders()
  // finds at least one provider (openrouter). This makes GET /ai/available-models
  // return 200. POST /ai/* endpoints resolve to openai (from user config or
  // operator default) which has no API key, so callLlmProvider returns
  // provider.no_credentials → 502 — no actual HTTP calls are made.
  const savedLlmEnv: Record<string, string | undefined> = {};
  for (const key of ['LLM_API_KEY', 'LLM_API_KEY_OPENAI', 'LLM_API_KEY_OPENROUTER', 'LLM_API_KEY_OLLAMA']) {
    savedLlmEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Dummy key only for OpenRouter — enough for provider discovery, not for real LLM calls.
  process.env['LLM_API_KEY_OPENROUTER'] = 'test-functional-key';

  // Dummy credential encryption key so /setup/provider-link and /credentials can
  // encrypt without a real production key. Must be exactly 64 hex chars (32 bytes).
  // Kept set for the app lifetime (NOT restored) — getEncryptionKey() reads it at
  // request time, so restoring/deleting it would make /credentials 500 mid-test.
  // It is process-local test material, not a secret.
  const TEST_CREDENTIAL_ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000001';
  process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_CREDENTIAL_ENCRYPTION_KEY;

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

  const stubTradertonClient = makeStubTradertonClient();
  await authRoutes(app, authConfig, db, redisClient, 'free', testPlansConfig as any);
  // Intervening optional args (llmCatalogDeps, agentCostEstimates, modelDefaults)
  // are genuinely unused by the harness — routes null-guard them. The client
  // MUST land in the tradertonReadClient slot (9th) per the agents.ts signature.
  await agentRoutes(
    app,
    db,
    testPlansConfig as any,
    undefined,
    undefined,
    undefined,
    redisClient,
    undefined,
    stubTradertonClient,
    5000,
  );
  await connectionRoutes(app, db, TEST_BUDGETS, redisClient, testPlansConfig as any, stubTradertonClient);
  await capabilityRoutes(app, db, testPlansConfig as any, TEST_BUDGETS, redisClient, stubTradertonClient, 5000);
  await botRoutes(app, lifecycleQueue, db, redisClient, testPlansConfig as any, stubTradertonClient);

  // Telegram webhook (unauthenticated, no token in test → returns 501)
  await telegramWebhookHandler(app, db, redisClient);
  await agentInteractivityRoutes(
    app,
    db,
    redisClient,
    undefined,
    undefined,
    testPlansConfig as any,
    undefined,
  );

  await analyticsRoutes(app, db, stubTradertonClient, 10_000);

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
  await exportRoutes(app, db, stubTradertonClient);

  await setupRoutes(app, db, testPlansConfig as any, {
    venues: {} as import('@herobids/domain').AppConfig['venues'],
    tradertonClient: stubTradertonClient,
  });

  await app.ready();

  // Restore LLM API key env vars so they don't leak between test files.
  // The dummy OpenRouter key set at the top is included in savedLlmEnv
  // (captured as undefined before we set it), so the restore loop deletes it.
  // Re-set it here so it persists for the lifetime of the test run.
  for (const [key, value] of Object.entries(savedLlmEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  process.env['LLM_API_KEY_OPENROUTER'] = 'test-functional-key';

  // Re-assert the dummy CREDENTIAL_ENCRYPTION_KEY (mirrors the OpenRouter re-set
  // above): getEncryptionKey() reads process.env at REQUEST time, so it must stay
  // set for the app lifetime. NOT restored — it is process-local test material.
  process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_CREDENTIAL_ENCRYPTION_KEY;

  return {
    app,
    db,
    redisClient,
    lifecycleQueue,
    // Test-only: seed the stub boundary's agent-scoped evidence stores.
    seedAgentFills: (agentId: string, rows: unknown[]): void => (stubTradertonClient as StubTradertonClientWithSeed).seedAgentFills(agentId, rows),
    seedAgentPositions: (agentId: string, rows: unknown[]): void => (stubTradertonClient as StubTradertonClientWithSeed).seedAgentPositions(agentId, rows),
  };
}

/**
 * The seed helpers attached to the stub client object (NOT part of the
 * TradertonClient contract — kept out of that type by design).
 */
type StubTradertonClientWithSeed = TradertonClient & {
  seedAgentFills: (agentId: string, rows: unknown[]) => void;
  seedAgentPositions: (agentId: string, rows: unknown[]) => void;
};

/** Truncate all test tables in FK-safe order. */
export async function truncateAll(db: ReturnType<typeof createDatabase>) {
  // NOTE: the trading tables (user_credentials, venue_accounts, bots, fills,
  // positions, decisions) were dropped from herobids by the trading-isolation
  // cutover — trading state now lives behind the REST boundary. They are
  // deliberately absent from this list; adding them back would fail with
  // "relation does not exist".
  await db.execute(sql`
    TRUNCATE
      connections,
      agent_skills,
      agent_runtime_sessions,
      agent_messages,
      agent_artifacts,
      agent_outbound_messages,
      skill_usage_events,
      skill_likes,
      skill_entitlements,
      skill_revisions,
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

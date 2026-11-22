/**
 * PATCH /agents/:id tick interval semantics against a real Postgres: `tickIntervalMs: null` clears the column
 * (back to unset, so the effective default applies), omitting the field leaves the stored value, and a number
 * writes it.
 *
 * Runs in a scratch database it creates and drops, and only against a local Postgres (DATABASE_URL on localhost).
 * Skipped otherwise.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { closeDatabase, createDatabase, type Database } from '@herobids/db';
import type { AuthConfig, PlansConfig } from '@herobids/domain';
import { AgentCreationConfigSchema, NON_TRADING_DEFAULT_TICK_INTERVAL_MS } from '@herobids/domain';
import { ExternalBackendClient, type ExternalBackendClientResult, type InvokeToolInput } from '@herobids/domain/external-backend';
import {
  createScratchDatabase,
  localDatabaseUrl,
  type ScratchDatabase,
} from '../../../../packages/db/src/test-helpers/scratch-database.js';
import { authPlugin, createSessionToken } from '../plugins/auth.js';
import { syncSystemSkills } from '../sync-system-skills.js';
import { agentRoutes } from './agents.js';

const BASE_URL = localDatabaseUrl();
const TEST_JWT_SECRET = 'test-secret-for-integration-tests-32ch!!';
const ONE_HOUR_MS = 3_600_000;
const TWO_HOURS_MS = 7_200_000;

function makeAuthConfig(): AuthConfig {
  return {
    publicBaseUrl: 'http://localhost:3000',
    frontendOrigin: 'http://localhost:5173',
    jwtSecret: TEST_JWT_SECRET,
    jwtTtlSecs: 3600,
    exchangeCodeTtlSecs: 60,
    googleClientId: 'test-client-id',
    googleClientSecret: 'test-client-secret',
    secureCookie: false,
    loginLinkTtlSecs: 600,
    loginLinkResendCooldownSecs: 60,
    loginLinkMaxSendsPerWindow: 5,
    loginLinkWindowSecs: 3600,
    loginLinkMaxSendsPerIpWindow: 10,
  };
}

function makePlansConfig(): PlansConfig {
  return {
    defaultPlanId: 'basic',
    plans: {
      basic: {
        entitlements: {
          skills: {
            canCreatePrivateSkills: false,
            canViewMarketplaceSkills: true,
            canPublishToMarketplace: true,
            autoPublishNonDraftSkills: true,
            canPriceSkills: false,
            canLikeMarketplaceSkills: true,
          },
          agents: { canViewOwnPrompts: true },
          limits: {
            maxAgents: 10,
            childAgentLimitCeiling: 0,
            maxBots: 5,
            maxConnections: 5,
            maxCredentials: 5,
            maxBindings: 5,
            maxVenueAccounts: 5,
            maxConcurrentBacktests: 3,
            liveEnabled: false,
          },
        },
        usage: {},
      },
    },
  };
}

/** The bot call a PATCH makes for an agent with no connections. Anything else fails. */
class QuietBoundary extends ExternalBackendClient {
  constructor() {
    super({
      baseUrl: 'http://127.0.0.1:9',
      consumerId: 'test-consumer',
      keyId: 'test-key',
      hmacSecret: 'test-hmac-secret',
      requestTimeoutMs: 1000,
    });
  }

  override async invoke(input: InvokeToolInput): Promise<ExternalBackendClientResult> {
    const requestId = crypto.randomUUID();
    if (input.toolName === 'list_owner_bots') {
      return { kind: 'success', requestId, correlationId: requestId, payload: { bots: [] } };
    }
    return { kind: 'transport_error', requestId, retryable: true, message: `unexpected tool ${input.toolName}` };
  }
}

async function buildApp(db: Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await authPlugin(app, { config: makeAuthConfig(), db });
  await agentRoutes(
    app,
    db,
    makePlansConfig(),
    undefined,
    undefined,
    undefined,
    { provider: 'openai' },
    new QuietBoundary(),
    undefined,
    undefined,
    undefined,
    AgentCreationConfigSchema.parse({}),
  );
  await app.ready();
  return app;
}

describe.skipIf(!BASE_URL)('PATCH /agents/:id tickIntervalMs (integration)', () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let app: FastifyInstance;
  let authHeader: { Authorization: string };

  beforeAll(async () => {
    scratch = await createScratchDatabase(BASE_URL!, '9999_all.sql');
    const scratchUrl = new URL(BASE_URL!);
    scratchUrl.pathname = `/${scratch.sql.options.database}`;
    db = createDatabase(scratchUrl.toString(), { max: 4 });
    await syncSystemSkills(db);
  }, 120_000);

  afterAll(async () => {
    if (db) await closeDatabase(db);
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.sql`TRUNCATE agent_skills, skill_usage_events, agents, sessions, users CASCADE`;
    const userId = `owner-${crypto.randomUUID().slice(0, 8)}`;
    await scratch.sql`INSERT INTO users (id, username, display_name, email, plan_id)
      VALUES (${userId}, ${userId.replace('-', '_')}, 'Owner', ${`${userId}@tick-patch.test.local`}, 'basic')`;
    const sessionId = crypto.randomUUID();
    await scratch.sql`INSERT INTO sessions (id, user_id, expires_at) VALUES (${sessionId}, ${userId}, ${new Date(Date.now() + 86_400_000)})`;
    authHeader = { Authorization: `Bearer ${await createSessionToken(makeAuthConfig(), userId, sessionId)}` };
    app = await buildApp(db);
  });

  afterEach(async () => {
    await app.close();
  });

  async function createAgent(tickIntervalMs?: number): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: authHeader,
      payload: { name: 'Researcher', prompt: 'Summarise the news.', skillIds: [], ...(tickIntervalMs !== undefined ? { tickIntervalMs } : {}) },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  async function patchAgent(agentId: string, payload: Record<string, unknown>) {
    const res = await app.inject({ method: 'PATCH', url: `/agents/${agentId}`, headers: authHeader, payload });
    expect(res.statusCode).toBe(200);
    return res.json() as { tickIntervalMs: number | null; effectiveTickIntervalMs: number | null; tickIntervalSource: string };
  }

  async function storedTick(agentId: string): Promise<number | null> {
    const [row] = await scratch.sql`SELECT tick_interval_ms FROM agents WHERE id = ${agentId}`;
    return (row!['tick_interval_ms'] as number | null) ?? null;
  }

  it('stores null when a create omits the tick', async () => {
    const agentId = await createAgent();
    expect(await storedTick(agentId)).toBeNull();
  });

  it('clears the column when a PATCH sends tickIntervalMs: null, and the effective default applies', async () => {
    const agentId = await createAgent(ONE_HOUR_MS);
    expect(await storedTick(agentId)).toBe(ONE_HOUR_MS);

    const body = await patchAgent(agentId, { tickIntervalMs: null });

    expect(await storedTick(agentId)).toBeNull();
    expect(body).toMatchObject({
      tickIntervalMs: null,
      effectiveTickIntervalMs: NON_TRADING_DEFAULT_TICK_INTERVAL_MS,
      tickIntervalSource: 'non_trading_default',
    });
  });

  it('leaves a stored tick untouched when a PATCH omits the field', async () => {
    const agentId = await createAgent(ONE_HOUR_MS);

    await patchAgent(agentId, { name: 'Renamed researcher' });

    expect(await storedTick(agentId)).toBe(ONE_HOUR_MS);
  });

  it('leaves an unset tick unset when a PATCH omits the field', async () => {
    const agentId = await createAgent();

    await patchAgent(agentId, { name: 'Renamed researcher' });

    expect(await storedTick(agentId)).toBeNull();
  });

  it('writes an explicit number from a PATCH', async () => {
    const agentId = await createAgent();

    const body = await patchAgent(agentId, { tickIntervalMs: TWO_HOURS_MS });

    expect(await storedTick(agentId)).toBe(TWO_HOURS_MS);
    expect(body).toMatchObject({ tickIntervalMs: TWO_HOURS_MS, tickIntervalSource: 'user' });
  });
});

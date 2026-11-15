/**
 * An external skill picked in the web form arrives as the UI id `ext:owner/repo/skill`; the agent (or a later save)
 * names the same skill `owner/repo@skill`. Through the real routes and a real Postgres, every spelling must end in
 * one `skills` row and one `agent_skills` row, with the original assignment provenance intact.
 *
 * Runs in a scratch database it creates and drops, and only against a local Postgres (DATABASE_URL on localhost).
 * Skipped otherwise.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { closeDatabase, createDatabase, externalSkillIdForRef, type Database } from '@herobids/db';
import type { AuthConfig, PlansConfig } from '@herobids/domain';
import { AgentCreationConfigSchema } from '@herobids/domain';
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
const CANONICAL_REF = 'o/r/s';
const EXTERNAL_SKILL_ID = externalSkillIdForRef(CANONICAL_REF);

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
  const skills = {
    canCreatePrivateSkills: false,
    canViewMarketplaceSkills: true,
    canPublishToMarketplace: true,
    autoPublishNonDraftSkills: true,
    canPriceSkills: false,
    canLikeMarketplaceSkills: true,
  };
  return {
    defaultPlanId: 'basic',
    plans: {
      basic: {
        entitlements: {
          skills,
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

describe.skipIf(!BASE_URL)('external skill spellings through POST and PATCH /agents (integration)', () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let app: FastifyInstance;
  let userId: string;
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
    await scratch.sql`DELETE FROM skills WHERE source_ref IS NOT NULL`;
    userId = `owner-${crypto.randomUUID().slice(0, 8)}`;
    await scratch.sql`INSERT INTO users (id, username, display_name, email, plan_id)
      VALUES (${userId}, ${userId.replace('-', '_')}, 'Owner', ${`${userId}@ext-skill.test.local`}, 'basic')`;
    const sessionId = crypto.randomUUID();
    await scratch.sql`INSERT INTO sessions (id, user_id, expires_at) VALUES (${sessionId}, ${userId}, ${new Date(Date.now() + 86_400_000)})`;
    authHeader = { Authorization: `Bearer ${await createSessionToken(makeAuthConfig(), userId, sessionId)}` };
    app = await buildApp(db);
  });

  afterEach(async () => {
    await app.close();
  });

  async function createAgent(skillIds: string[]): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: authHeader,
      payload: { name: 'Job hunter', prompt: 'Find jobs.', skillIds },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  async function updateAgentSkills(agentId: string, skillIds: string[]): Promise<void> {
    const res = await app.inject({ method: 'PATCH', url: `/agents/${agentId}`, headers: authHeader, payload: { skillIds } });
    expect(res.statusCode).toBe(200);
  }

  async function externalSkillRows() {
    return scratch.sql`SELECT id, slug, source_ref FROM skills WHERE source_ref IS NOT NULL`;
  }

  async function externalAssignments(agentId: string) {
    return scratch.sql`SELECT skill_id, assignment_source, assigned_at, assigned_by_user_id FROM agent_skills
      WHERE agent_id = ${agentId} AND skill_id IN (SELECT id FROM skills WHERE source_ref IS NOT NULL)`;
  }

  async function listedSkillIds(agentId: string): Promise<string[]> {
    const res = await app.inject({ method: 'GET', url: `/agents/${agentId}`, headers: authHeader });
    expect(res.statusCode).toBe(200);
    return (res.json() as { skillIds: string[] }).skillIds;
  }

  it('an agent created with ext:o/r/s and saved with o/r@s has one skills row, one agent_skills row and lists the skill once', async () => {
    const agentId = await createAgent(['ext:o/r/s']);

    await updateAgentSkills(agentId, ['o/r@s']);

    const rows = await externalSkillRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: EXTERNAL_SKILL_ID, slug: CANONICAL_REF, source_ref: CANONICAL_REF });
    expect(await externalAssignments(agentId)).toHaveLength(1);
    const listed = await listedSkillIds(agentId);
    expect(listed.filter((id) => id === EXTERNAL_SKILL_ID)).toHaveLength(1);
  });

  it('an agent created with o/r@s and saved with ext:o/r/s still has one skills row and one agent_skills row', async () => {
    const agentId = await createAgent(['o/r@s']);

    await updateAgentSkills(agentId, ['ext:o/r/s']);

    expect(await externalSkillRows()).toHaveLength(1);
    expect(await externalAssignments(agentId)).toHaveLength(1);
    expect((await listedSkillIds(agentId)).filter((id) => id === EXTERNAL_SKILL_ID)).toHaveLength(1);
  });

  it('creating an agent with all three spellings in one request stores no ext: row and assigns the skill once', async () => {
    const agentId = await createAgent(['ext:o/r/s', 'o/r/s', 'o/r@s']);

    const rows = await externalSkillRows();
    expect(rows).toHaveLength(1);
    expect(rows.some((row) => String(row['source_ref']).startsWith('ext:') || String(row['slug']).startsWith('ext:'))).toBe(false);
    expect(await externalAssignments(agentId)).toHaveLength(1);
  });

  it('saving the skill list again under another spelling keeps the original assignment provenance', async () => {
    const agentId = await createAgent(['ext:o/r/s']);
    const [before] = await externalAssignments(agentId);

    await updateAgentSkills(agentId, ['o/r@s']);

    const [after] = await externalAssignments(agentId);
    expect(before).toBeDefined();
    expect(after).toMatchObject({
      skill_id: EXTERNAL_SKILL_ID,
      assignment_source: before!['assignment_source'],
      assigned_by_user_id: before!['assigned_by_user_id'],
    });
    expect((after!['assigned_at'] as Date).toISOString()).toBe((before!['assigned_at'] as Date).toISOString());
  });
});

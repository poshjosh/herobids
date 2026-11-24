import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { Redis } from 'ioredis';
import {
  createDatabase,
  users,
  sessions,
  agents,
  agentDocuments,
  agentRuntimeSessions,
  generateAgentApiKey,
} from '@herobids/db';
import type { AuthConfig } from '@herobids/domain';
import { authPlugin, createSessionToken } from '../plugins/auth.js';
import { agentDocumentRoutes } from './agent-documents.js';

const SKIP = !process.env['DATABASE_URL'];

const TEST_JWT_SECRET = 'test-secret-for-integration-tests-32ch!!';

const PROJECTED_KEYS = [
  'documentId',
  'extractionStatus',
  'filename',
  'lifecycleState',
  'mimeType',
  'sizeBytes',
  'source',
  'sourceDocumentId',
].sort();

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

type Db = ReturnType<typeof createDatabase>;

async function buildApp(db: Db, redis: Redis): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await authPlugin(app, { config: makeAuthConfig(), db });
  await agentDocumentRoutes(app, db, redis);
  await app.ready();
  return app;
}

async function seedUser(db: Db): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = `owner-${suffix}`;
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    username: `owner_${suffix}`,
    displayName: 'Owner',
    email: `${userId}@agent-docs.test.local`,
    planId: 'free',
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

interface SeededAgent {
  agentId: string;
  rawKey: string;
}

async function seedAgent(db: Db, userId: string): Promise<SeededAgent> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const agentId = `agent-${suffix}`;
  const now = new Date();
  await db.insert(agents).values({
    id: agentId,
    userId,
    name: `Agent ${suffix}`,
    prompt: `documents prompt ${suffix}`,
    skillIds: [],
    status: 'active',
    creatorType: 'user',
    creatorId: userId,
    parentAgentId: null,
    depth: 0,
    childAgentLimit: 0,
    grantAnyConnectionToChildren: false,
    permissionLevel: 'standard',
    createdAt: now,
    updatedAt: now,
  });
  const generated = generateAgentApiKey();
  await db.insert(agentRuntimeSessions).values({
    id: `runtime-${suffix}`,
    agentId,
    status: 'running',
    apiKeyHash: generated.keyHash,
    startedAt: now,
  });
  return { agentId, rawKey: generated.rawKey };
}

interface SeedDocument {
  agentId: string;
  userId: string;
  filename?: string;
  lifecycleState?: 'staged' | 'materialized' | 'deleted';
  deletedAt?: Date | null;
}

async function seedDocument(db: Db, doc: SeedDocument): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(agentDocuments).values({
    id,
    agentId: doc.agentId,
    userId: doc.userId,
    source: 'control_plane',
    originalFilename: doc.filename ?? `${id}.txt`,
    mimeType: 'text/plain',
    sizeBytes: 42,
    originalStoreKey: `secret-original/${id}`,
    extractedTextStoreKey: `secret-extracted/${id}`,
    extractionStatus: 'ready',
    lifecycleState: doc.lifecycleState ?? 'materialized',
    deletedAt: doc.deletedAt ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function userToken(db: Db, userId: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
  });
  return createSessionToken(makeAuthConfig(), userId, sessionId);
}

describe.skipIf(SKIP)('agent document list for the agent itself (integration)', () => {
  let db: Db;
  let redis: Redis;
  const apps: FastifyInstance[] = [];

  beforeAll(() => {
    db = createDatabase(process.env['DATABASE_URL']!);
    redis = new Redis();
  });

  afterAll(() => {
    redis.disconnect();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE agent_documents, agent_runtime_sessions, agents, sessions, users CASCADE`);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function appWith(): Promise<FastifyInstance> {
    const app = await buildApp(db, redis);
    apps.push(app);
    return app;
  }

  it('an agent key lists only its own materialized documents, projected to model fields', async () => {
    const userId = await seedUser(db);
    const caller = await seedAgent(db, userId);
    const other = await seedAgent(db, userId);
    const ownId = await seedDocument(db, { agentId: caller.agentId, userId, filename: 'cv.pdf' });
    await seedDocument(db, { agentId: other.agentId, userId, filename: 'theirs.pdf' });
    const app = await appWith();

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${caller.agentId}/documents/available`,
      headers: { Authorization: `Bearer ${caller.rawKey}` },
    });

    expect(res.statusCode).toBe(200);
    const documents = res.json().documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(1);
    expect(documents[0]).toEqual({
      documentId: ownId,
      filename: 'cv.pdf',
      mimeType: 'text/plain',
      sizeBytes: 42,
      lifecycleState: 'materialized',
      sourceDocumentId: null,
      source: 'control_plane',
      extractionStatus: 'ready',
    });
    expect(Object.keys(documents[0]!).sort()).toEqual(PROJECTED_KEYS);
  });

  it('excludes staged, deleted-state and soft-deleted documents', async () => {
    const userId = await seedUser(db);
    const caller = await seedAgent(db, userId);
    const materialized = await seedDocument(db, { agentId: caller.agentId, userId });
    await seedDocument(db, { agentId: caller.agentId, userId, lifecycleState: 'staged' });
    await seedDocument(db, { agentId: caller.agentId, userId, lifecycleState: 'deleted', deletedAt: new Date() });
    await seedDocument(db, { agentId: caller.agentId, userId, lifecycleState: 'materialized', deletedAt: new Date() });
    const app = await appWith();

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${caller.agentId}/documents/available`,
      headers: { Authorization: `Bearer ${caller.rawKey}` },
    });

    expect(res.statusCode).toBe(200);
    const documents = res.json().documents as Array<{ documentId: string }>;
    expect(documents.map((d) => d.documentId)).toEqual([materialized]);
  });

  it('never includes storage keys in the response body', async () => {
    const userId = await seedUser(db);
    const caller = await seedAgent(db, userId);
    await seedDocument(db, { agentId: caller.agentId, userId });
    const app = await appWith();

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${caller.agentId}/documents/available`,
      headers: { Authorization: `Bearer ${caller.rawKey}` },
    });

    expect(res.body).not.toContain('secret-original/');
    expect(res.body).not.toContain('secret-extracted/');
    expect(res.body).not.toContain('originalStoreKey');
    expect(res.body).not.toContain('extractedTextStoreKey');
  });

  it('caps the list at 100 documents', async () => {
    const userId = await seedUser(db);
    const caller = await seedAgent(db, userId);
    for (let i = 0; i < 101; i++) {
      await seedDocument(db, { agentId: caller.agentId, userId });
    }
    const app = await appWith();

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${caller.agentId}/documents/available`,
      headers: { Authorization: `Bearer ${caller.rawKey}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().documents).toHaveLength(100);
  });

  it('an agent key cannot list the documents of another agent', async () => {
    const userId = await seedUser(db);
    const caller = await seedAgent(db, userId);
    const other = await seedAgent(db, userId);
    await seedDocument(db, { agentId: other.agentId, userId });
    const app = await appWith();

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${other.agentId}/documents/available`,
      headers: { Authorization: `Bearer ${caller.rawKey}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('secret-original/');
  });

  it('the owner session lists the agent documents; a user who does not own the agent gets 404', async () => {
    const ownerId = await seedUser(db);
    const strangerId = await seedUser(db);
    const agent = await seedAgent(db, ownerId);
    const docId = await seedDocument(db, { agentId: agent.agentId, userId: ownerId });
    const app = await appWith();

    const ownerRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent.agentId}/documents/available`,
      headers: { Authorization: `Bearer ${await userToken(db, ownerId)}` },
    });
    expect(ownerRes.statusCode).toBe(200);
    expect((ownerRes.json().documents as Array<{ documentId: string }>).map((d) => d.documentId)).toEqual([docId]);

    const strangerRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent.agentId}/documents/available`,
      headers: { Authorization: `Bearer ${await userToken(db, strangerId)}` },
    });
    expect(strangerRes.statusCode).toBe(404);
    expect(strangerRes.body).not.toContain(docId);
  });
});

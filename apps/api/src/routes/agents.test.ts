import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
  });
}

function buildDb(options: {
  agentRows?: Array<Record<string, unknown>>;
  activeLinkRows?: Array<Record<string, unknown>>;
  txAgentRows?: Array<Record<string, unknown>>;
} = {}) {
  const insertedValues: Array<Record<string, unknown>> = [];
  const updateSets: Array<Record<string, unknown>> = [];
  const deletedTargets: unknown[] = [];
  const selectResponses = [
    ...(options.agentRows ? [options.agentRows] : [[]]),
    ...(options.activeLinkRows ? [options.activeLinkRows] : [[]]),
    ...(options.txAgentRows ? [options.txAgentRows] : [[]]),
  ];

  const db: any = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => Promise.resolve(selectResponses.shift() ?? [])),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updateSets.push(values);
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(values['status'] === 'starting' ? [{ id: 'agent-1' }] : []),
          }),
        };
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        insertedValues.push(values);
        return Promise.resolve();
      }),
    }),
    transaction: vi.fn().mockImplementation(async (callback: (tx: any) => Promise<unknown>) => callback(db)),
    delete: vi.fn().mockImplementation((target: unknown) => {
      deletedTargets.push(target);
      return {
        where: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };

  return { db, insertedValues, updateSets, deletedTargets };
}

describe('agent routes lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns starting and persists a starting session when /start is called', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, insertedValues, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      txAgentRows: [{ id: 'agent-1' }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/start' });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(expect.objectContaining({ status: 'starting', sessionId: expect.any(String) }));
    expect(updateSets).toContainEqual(expect.objectContaining({ status: 'starting', pauseState: null }));
    expect(insertedValues).toContainEqual(expect.objectContaining({ agentId: 'agent-1', status: 'starting' }));
  });

  it('rejects a second /start when the agent is already starting', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'starting', userId: TEST_USER_ID }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/start' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_stopped');
  });

  it('returns 404 when the user does not own the agent', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb();

    const app = Fastify();
    decorateWithAuth(app, 'other-user');
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/start' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('rejects start when agent is running (not stopped)', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'running', userId: TEST_USER_ID }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/start' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_stopped');
  });

  it('deletes outbound messages before deleting the agent', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { agentOutboundMessages, agentArtifacts, agentRuntimeSessions, agents } = await import('@herobids/db');
    const { db, deletedTargets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(204);
    expect(deletedTargets).toEqual([
      agentOutboundMessages,
      agentArtifacts,
      agentRuntimeSessions,
      agents,
    ]);
  });
});

describe('agent routes config update (PATCH /agents/:id)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['active'],
    ['starting'],
    ['paused'],
    ['unhealthy'],
  ])('rejects PATCH with 409 when agent status is %s', async (status) => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status, userId: TEST_USER_ID, skillIds: [] }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { name: 'new name' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('agent_not_editable');
  });

  it.each([
    ['stopped'],
    ['crashed'],
  ])('allows PATCH and persists changes when agent status is %s', async (status) => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = { id: 'agent-1', userId: TEST_USER_ID, status, skillIds: [], name: 'new name', prompt: 'p' };
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status, userId: TEST_USER_ID, skillIds: [], toolPolicy: null }],
      activeLinkRows: [updatedAgent],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { name: 'new name' },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({ name: 'new name' }));
  });

  it('returns 404 when the agent does not exist or belongs to another user', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({ agentRows: [] });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { name: 'new name' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('returns 400 for an invalid payload', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [] }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      // name must be min(1) — empty string should fail validation
      payload: { name: '' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });
});
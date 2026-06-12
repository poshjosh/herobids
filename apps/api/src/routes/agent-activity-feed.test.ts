import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const TEST_USER_ID = 'user-1';
const AGENT_ID = 'agent-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = TEST_USER_ID;
    request.userPlanId = 'free';
  });
}

function buildDb(options: {
  agentRows?: Array<Record<string, unknown>>;
  protocolRows?: Array<Record<string, unknown>>;
  sessionRows?: Array<Record<string, unknown>>;
  outboundRows?: Array<Record<string, unknown>>;
  artifactRows?: Array<Record<string, unknown>>;
} = {}) {
  // Track which table is being queried to return appropriate data
  let queryCount = 0;
  const responsePlan = [
    options.agentRows ?? [], // first select = agent ownership check
    options.protocolRows ?? [], // protocol messages
    options.sessionRows ?? [], // sessions
    options.outboundRows ?? [], // outbound messages
    options.artifactRows ?? [], // artifacts
  ];

  const db: Record<string, unknown> = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const idx = queryCount++;
          const response = responsePlan[idx] ?? [];
          return {
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockImplementation(() => Promise.resolve(response)),
            }),
            limit: vi.fn().mockImplementation(() => Promise.resolve(response)),
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(response).then(resolve),
          };
        }),
      }),
    }),
    transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(db)),
  };

  return { db };
}

describe('GET /agents/:id/activity-feed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when agent not found', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({ agentRows: [] });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db as any);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/activity-feed` });
    expect(res.statusCode).toBe(404);
  });

  it('returns normalized activity entries from protocol messages', async () => {
    const { agentRoutes } = await import('./agents.js');
    const now = new Date();
    const { db } = buildDb({
      agentRows: [{ id: AGENT_ID, userId: TEST_USER_ID }],
      protocolRows: [{
        id: 'msg-1',
        messageId: 'mid-1',
        correlationId: 'corr-1',
        actorType: 'agent',
        actorId: AGENT_ID,
        agentId: AGENT_ID,
        botId: null,
        type: 'instance.decision.rejected',
        direction: 'outbound',
        schemaVersion: 'v1',
        sequence: null,
        traceId: null,
        processingStatus: 'processed',
        errorDetail: { code: 'risk.exceeded', message: 'Notional too large' },
        payload: null,
        createdAt: now,
      }],
      sessionRows: [{
        id: 'sess-1',
        agentId: AGENT_ID,
        status: 'running',
        lastHeartbeatAt: now,
        cpuPct: 2,
        memoryBytes: 512,
        startedAt: new Date(now.getTime() - 60000),
        stoppedAt: null,
      }],
      outboundRows: [],
      artifactRows: [],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db as any);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/activity-feed?limit=10` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.entries).toBeDefined();
    expect(body.hasMore).toBe(false);
    expect(body.entries.length).toBeGreaterThan(0);

    // Should contain the decision rejection
    const rejection = body.entries.find((e: Record<string, unknown>) => e.eventType === 'decision.rejected');
    expect(rejection).toBeDefined();
    expect(rejection.title).toBe('Decision rejected');
    expect(rejection.category).toBe('decision');
    expect(rejection.severity).toBe('warn');

    // Should contain the session start
    const sessionStart = body.entries.find((e: Record<string, unknown>) => e.title === 'Session started');
    expect(sessionStart).toBeDefined();
    expect(sessionStart.category).toBe('runtime');
  });

  it('returns entries sorted by timestamp descending', async () => {
    const { agentRoutes } = await import('./agents.js');
    const earlier = new Date('2026-06-11T10:00:00Z');
    const later = new Date('2026-06-11T11:00:00Z');

    const { db } = buildDb({
      agentRows: [{ id: AGENT_ID, userId: TEST_USER_ID }],
      protocolRows: [
        {
          id: 'msg-1', messageId: 'mid-1', correlationId: 'c1',
          actorType: 'agent', actorId: AGENT_ID, agentId: AGENT_ID, botId: null,
          type: 'agent.decision.submit', direction: 'inbound', schemaVersion: 'v1',
          sequence: null, traceId: null, processingStatus: 'processed', errorDetail: null,
          payload: null,
          createdAt: earlier,
        },
        {
          id: 'msg-2', messageId: 'mid-2', correlationId: 'c2',
          actorType: 'agent', actorId: AGENT_ID, agentId: AGENT_ID, botId: null,
          type: 'agent.message.send', direction: 'inbound', schemaVersion: 'v1',
          sequence: null, traceId: null, processingStatus: 'processed', errorDetail: null,
          payload: null,
          createdAt: later,
        },
      ],
      sessionRows: [],
      outboundRows: [],
      artifactRows: [],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db as any);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/activity-feed` });
    const body = JSON.parse(res.body);
    expect(body.entries.length).toBe(2);
    // Later timestamp should come first
    expect(new Date(body.entries[0].timestamp).getTime()).toBeGreaterThan(
      new Date(body.entries[1].timestamp).getTime(),
    );
  });

  it('suppresses heartbeat protocol rows from the feed', async () => {
    const { agentRoutes } = await import('./agents.js');
    const now = new Date('2026-06-11T11:00:00Z');

    const { db } = buildDb({
      agentRows: [{ id: AGENT_ID, userId: TEST_USER_ID }],
      protocolRows: [
        {
          id: 'msg-heartbeat', messageId: 'mid-heartbeat', correlationId: 'c-heartbeat',
          actorType: 'agent', actorId: AGENT_ID, agentId: AGENT_ID, botId: null,
          type: 'agent.runtime.heartbeat', direction: 'inbound', schemaVersion: 'v1',
          sequence: null, traceId: null, processingStatus: 'processed', errorDetail: null,
          payload: null,
          createdAt: now,
        },
        {
          id: 'msg-visible', messageId: 'mid-visible', correlationId: 'c-visible',
          actorType: 'agent', actorId: AGENT_ID, agentId: AGENT_ID, botId: null,
          type: 'agent.message.send', direction: 'inbound', schemaVersion: 'v1',
          sequence: null, traceId: null, processingStatus: 'processed', errorDetail: null,
          payload: null,
          createdAt: new Date(now.getTime() - 1_000),
        },
      ],
      sessionRows: [],
      outboundRows: [],
      artifactRows: [],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db as any);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/activity-feed?limit=10` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].id).toBe('msg-visible');
  });

  it('includes runtime activity events in the feed with correct event types', async () => {
    const { agentRoutes } = await import('./agents.js');
    const now = new Date();
    const { db } = buildDb({
      agentRows: [{ id: AGENT_ID, userId: TEST_USER_ID }],
      protocolRows: [
        {
          id: 'msg-tick', messageId: 'mid-tick', correlationId: 'c-tick',
          actorType: 'agent', actorId: AGENT_ID, agentId: AGENT_ID, botId: null,
          type: 'agent.tick.started', direction: 'inbound', schemaVersion: 'v1',
          sequence: null, traceId: null, processingStatus: 'processed', errorDetail: null,
          payload: { tickId: 'tick-001', trigger: 'scheduled', positionSide: 'none', hasWakeSignal: false },
          createdAt: new Date(now.getTime() - 2_000),
        },
        {
          id: 'msg-llm', messageId: 'mid-llm', correlationId: 'c-llm',
          actorType: 'agent', actorId: AGENT_ID, agentId: AGENT_ID, botId: null,
          type: 'agent.llm.completed', direction: 'inbound', schemaVersion: 'v1',
          sequence: null, traceId: null, processingStatus: 'processed', errorDetail: null,
          payload: { tickId: 'tick-001', phase: 'scout', model: 'gpt-4o-mini', turnsUsed: 2, finishReason: 'stop' },
          createdAt: new Date(now.getTime() - 1_000),
        },
      ],
      sessionRows: [],
      outboundRows: [],
      artifactRows: [],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db as any);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/activity-feed?limit=10` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    const tickEntry = body.entries.find((e: Record<string, unknown>) => e.id === 'msg-tick');
    expect(tickEntry).toBeDefined();
    expect(tickEntry.eventType).toBe('tick.started');

    const llmEntry = body.entries.find((e: Record<string, unknown>) => e.id === 'msg-llm');
    expect(llmEntry).toBeDefined();
    expect(llmEntry.eventType).toBe('llm.completed');
    expect(llmEntry.detail.payload).toMatchObject({ turnsUsed: 2, phase: 'scout' });
  });

  it('marks runtime activity failures as warn severity in the feed', async () => {
    const { agentRoutes } = await import('./agents.js');
    const now = new Date();
    const { db } = buildDb({
      agentRows: [{ id: AGENT_ID, userId: TEST_USER_ID }],
      protocolRows: [
        {
          id: 'msg-llm-error', messageId: 'mid-llm-error', correlationId: 'c-llm-error',
          actorType: 'agent', actorId: AGENT_ID, agentId: AGENT_ID, botId: null,
          type: 'agent.llm.completed', direction: 'inbound', schemaVersion: 'v1',
          sequence: null, traceId: null, processingStatus: 'processed', errorDetail: null,
          payload: { tickId: 'tick-001', phase: 'judge', model: 'gpt-4o-mini', turnsUsed: 0, finishReason: 'error' },
          createdAt: new Date(now.getTime() - 2_000),
        },
        {
          id: 'msg-tool-error', messageId: 'mid-tool-error', correlationId: 'c-tool-error',
          actorType: 'agent', actorId: AGENT_ID, agentId: AGENT_ID, botId: null,
          type: 'agent.tool.result', direction: 'inbound', schemaVersion: 'v1',
          sequence: null, traceId: null, processingStatus: 'processed', errorDetail: null,
          payload: { tickId: 'tick-001', phase: 'scout', toolName: 'list_bots', status: 'error', correlationId: 'tool-c-1', summary: 'tool rejected: list_bots' },
          createdAt: new Date(now.getTime() - 1_000),
        },
      ],
      sessionRows: [],
      outboundRows: [],
      artifactRows: [],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db as any);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/activity-feed?limit=10` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.entries.find((e: Record<string, unknown>) => e.id === 'msg-llm-error')?.severity).toBe('warn');
    expect(body.entries.find((e: Record<string, unknown>) => e.id === 'msg-tool-error')?.severity).toBe('warn');
  });

  it('marks llm turn-limit completions as warn severity in the feed', async () => {
    const { agentRoutes } = await import('./agents.js');
    const now = new Date();
    const { db } = buildDb({
      agentRows: [{ id: AGENT_ID, userId: TEST_USER_ID }],
      protocolRows: [
        {
          id: 'msg-llm-turn-limit', messageId: 'mid-llm-turn-limit', correlationId: 'c-llm-turn-limit',
          actorType: 'agent', actorId: AGENT_ID, agentId: AGENT_ID, botId: null,
          type: 'agent.llm.completed', direction: 'inbound', schemaVersion: 'v1',
          sequence: null, traceId: null, processingStatus: 'processed', errorDetail: null,
          payload: { tickId: 'tick-001', phase: 'judge', model: 'gpt-4o-mini', turnsUsed: 5, finishReason: 'turn_limit' },
          createdAt: new Date(now.getTime() - 1_000),
        },
      ],
      sessionRows: [],
      outboundRows: [],
      artifactRows: [],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db as any);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/activity-feed?limit=10` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.entries.find((e: Record<string, unknown>) => e.id === 'msg-llm-turn-limit')?.severity).toBe('warn');
  });

  it('keeps scout turn-limit completions at info severity in the feed', async () => {
    const { agentRoutes } = await import('./agents.js');
    const now = new Date();
    const { db } = buildDb({
      agentRows: [{ id: AGENT_ID, userId: TEST_USER_ID }],
      protocolRows: [
        {
          id: 'msg-scout-turn-limit', messageId: 'mid-scout-turn-limit', correlationId: 'c-scout-turn-limit',
          actorType: 'agent', actorId: AGENT_ID, agentId: AGENT_ID, botId: null,
          type: 'agent.llm.completed', direction: 'inbound', schemaVersion: 'v1',
          sequence: null, traceId: null, processingStatus: 'processed', errorDetail: null,
          payload: { tickId: 'tick-001', phase: 'scout', model: 'gpt-4o-mini', turnsUsed: 3, finishReason: 'turn_limit' },
          createdAt: new Date(now.getTime() - 1_000),
        },
      ],
      sessionRows: [],
      outboundRows: [],
      artifactRows: [],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db as any);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/activity-feed?limit=10` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.entries.find((e: Record<string, unknown>) => e.id === 'msg-scout-turn-limit')?.severity).toBe('info');
  });
});

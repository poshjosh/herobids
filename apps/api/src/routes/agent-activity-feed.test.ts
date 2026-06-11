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
        type: 'platform.decision.rejected',
        direction: 'outbound',
        schemaVersion: 'v1',
        sequence: null,
        traceId: null,
        processingStatus: 'processed',
        errorDetail: { code: 'risk.exceeded', message: 'Notional too large' },
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
          type: 'agent.heartbeat', direction: 'inbound', schemaVersion: 'v1',
          sequence: null, traceId: null, processingStatus: 'processed', errorDetail: null,
          createdAt: earlier,
        },
        {
          id: 'msg-2', messageId: 'mid-2', correlationId: 'c2',
          actorType: 'agent', actorId: AGENT_ID, agentId: AGENT_ID, botId: null,
          type: 'agent.send_message', direction: 'inbound', schemaVersion: 'v1',
          sequence: null, traceId: null, processingStatus: 'processed', errorDetail: null,
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
});

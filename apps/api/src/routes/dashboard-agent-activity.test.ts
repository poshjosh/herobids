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
} = {}) {
  let queryIndex = 0;
  const responsePlan = [
    options.agentRows ?? [],
    options.protocolRows ?? [],
    options.sessionRows ?? [],
  ];

  const db: Record<string, unknown> = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const response = responsePlan[queryIndex++] ?? [];
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
  };

  return { db };
}

describe('GET /dashboard/agent-activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns older entries when a cursor is provided', async () => {
    const { dashboardRoutes } = await import('./dashboard.js');
    const newer = new Date('2026-06-11T12:05:00Z');
    const older = new Date('2026-06-11T11:05:00Z');

    const { db } = buildDb({
      agentRows: [{ id: AGENT_ID, name: 'Agent A', userId: TEST_USER_ID }],
      protocolRows: [
        {
          id: 'msg-new',
          messageId: 'mid-new',
          correlationId: 'c-new',
          actorType: 'agent',
          actorId: AGENT_ID,
          agentId: AGENT_ID,
          botId: null,
          type: 'agent.send_message',
          direction: 'outbound',
          schemaVersion: 'v1',
          sequence: null,
          traceId: null,
          processingStatus: 'processed',
          errorDetail: null,
          createdAt: newer,
        },
        {
          id: 'msg-old',
          messageId: 'mid-old',
          correlationId: 'c-old',
          actorType: 'agent',
          actorId: AGENT_ID,
          agentId: AGENT_ID,
          botId: null,
          type: 'agent.heartbeat',
          direction: 'inbound',
          schemaVersion: 'v1',
          sequence: null,
          traceId: null,
          processingStatus: 'processed',
          errorDetail: null,
          createdAt: older,
        },
      ],
      sessionRows: [],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await dashboardRoutes(app, db as any);

    const res = await app.inject({ method: 'GET', url: `/dashboard/agent-activity?limit=1&before=${newer.toISOString()}` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].id).toBe('msg-old');
    expect(body.hasMore).toBe(false);
  });
});
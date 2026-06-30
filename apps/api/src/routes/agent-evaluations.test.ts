import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { Queue } from 'bullmq';
import type { Database } from '@herobids/db';
import { agentEvaluationRoutes } from './agent-evaluations.js';
import type { EvaluationRouteConfig, NarrativeLlmDeps } from './agent-evaluations.js';

// ── Mock resolveScope to throw, testing the 400 status code change ──────────

vi.mock('@herobids/db', async () => {
  const actual = await vi.importActual('@herobids/db');
  return {
    ...(actual as Record<string, unknown>),
    resolveScope: vi.fn(),
  };
});

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>) {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = TEST_USER_ID;
  });
}

/**
 * Build a mock DB that returns an agent row for the ownership check
 * but delegates actual resolveScope to the mocked version.
 */
function buildMockDb(agentExists = true): Database {
  const makeChain = (value: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit']) {
      chain[m] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) => Promise.resolve(value).then(resolve, reject);
    return chain;
  };

  return {
    select: vi.fn().mockImplementation(() =>
      makeChain(agentExists ? [{ id: 'agent-1', userId: TEST_USER_ID }] : []),
    ),
    transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({})),
  } as unknown as Database;
}

function buildMockQueue(): Queue {
  return {
    add: vi.fn().mockResolvedValue({ id: 'job-1' }),
  } as unknown as Queue;
}

const evalConfig: EvaluationRouteConfig = {
  storageRoot: '/tmp/test-eval-artifacts',
  maxRuntimeMs: 30_000,
  maxAttempts: 3,
};

const narrativeLlmDeps: NarrativeLlmDeps = {
  provider: 'openai',
  baseUrl: undefined,
  timeoutMs: 30_000,
  maxTokens: 4096,
  providersYaml: { providers: {} },
  catalogTimeoutMs: 5_000,
  catalogCacheTtlMs: 300_000,
  catalogLocality: 'us',
};

describe('POST /agents/:id/evaluations — scope resolution failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 (not 404) when scope resolution fails', async () => {
    // Import the mocked resolveScope
    const { resolveScope } = await import('@herobids/db');
    vi.mocked(resolveScope).mockRejectedValue(
      new Error('No session found for agent agent-1. Start the agent to create a session first.'),
    );

    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb(true);
    const queue = buildMockQueue();
    await agentEvaluationRoutes(app, queue, db, evalConfig, narrativeLlmDeps);

    const res = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/evaluations',
      payload: { scope: { type: 'latestSession' } },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('scope_resolution_failed');
    expect(body.message).toContain('No session found for agent');
    expect(body.message).toContain('Start the agent to create a session first.');
  });

  it('returns 404 when agent does not exist (ownership check)', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb(false); // agent does not exist
    const queue = buildMockQueue();
    await agentEvaluationRoutes(app, queue, db, evalConfig, narrativeLlmDeps);

    const res = await app.inject({
      method: 'POST',
      url: '/agents/agent-nonexistent/evaluations',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});

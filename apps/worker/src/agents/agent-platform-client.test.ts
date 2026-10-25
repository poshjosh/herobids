import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { createAgentPlatformClient, createAgentPlatformClientFromEnv } from './agent-platform-client.js';
import { agentCreationTools } from '../tools/agent-creation.js';

const API_KEY = 'agk_test_secret_key_value_that_must_not_leak';
const BASE_URL = 'http://api.test:3000';
const AGENT_ID = 'agent-1';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fetchReturning(response: Response) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response);
}

function makeLogger() {
  return { warn: vi.fn() };
}

function makeClient(fetchImpl: typeof fetch, logger = makeLogger(), timeoutMs = 5_000) {
  return createAgentPlatformClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    agentId: AGENT_ID,
    timeoutMs,
    logger,
    fetchImpl,
  });
}

describe('agent platform client', () => {
  it('sends the agent key only as a bearer token to the configured base URL', async () => {
    const fetchImpl = fetchReturning(jsonResponse(200, {
      id: AGENT_ID, childAgentLimit: 2, childCount: 0, remainingChildAllowance: 2,
    }));
    await makeClient(fetchImpl).getOwnAllowance();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE_URL}/agents/${AGENT_ID}/child-allowance`);
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}` });
  });

  it('forwards only name, prompt, skillIds and connectionIds when creating a child', async () => {
    const fetchImpl = fetchReturning(jsonResponse(201, { id: 'child-1', depth: 1, creatorId: 'ignored' }));
    const result = await makeClient(fetchImpl).createChildAgent({
      name: 'Research child',
      prompt: 'Summarise the market.',
      skillIds: ['skill-1'],
    });

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Research child',
      prompt: 'Summarise the market.',
      skillIds: ['skill-1'],
    });
    expect(result).toEqual({ ok: true, data: { id: 'child-1', depth: 1 } });
  });

  it('a 403 response maps to a namespaced forbidden error without the response body', async () => {
    const fetchImpl = fetchReturning(jsonResponse(403, { error: 'forbidden', echo: API_KEY }));
    const result = await makeClient(fetchImpl).pauseChildAgent('child-1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('agent.platform.forbidden');
    expect(result.error.retryable).toBe(false);
    expect(JSON.stringify(result.error)).not.toContain(API_KEY);
  });

  it('a 403 from the platform reaches the model as a namespaced tool error', async () => {
    const fetchImpl = fetchReturning(jsonResponse(403, { error: 'agent.create.allowance_exhausted' }));
    const client = makeClient(fetchImpl);
    const createAgentTool = agentCreationTools.find((t) => t.name === 'create_agent')!;
    const ctx: ToolContext = {
      agentId: AGENT_ID,
      sessionId: 'session-1',
      phase: 'judge',
      executionMode: 'paper',
      permissionLevel: 'standard',
      redis: {
        hset: vi.fn(async () => 1),
        hget: vi.fn(async () => null),
        hgetall: vi.fn(async () => null),
        hdel: vi.fn(async () => 0),
        publish: vi.fn(async () => 0),
      },
      publishToInbound: vi.fn(async () => undefined),
      agentPlatform: client,
    };

    const result = await createAgentTool.execute({ name: 'Research child', prompt: 'Summarise.' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('agent.create.allowance_exhausted');
    expect(result.error ?? '').not.toContain(API_KEY);
  });

  it('a 429 response maps to a retryable rate-limit error', async () => {
    const fetchImpl = fetchReturning(jsonResponse(429, { error: 'rate_limited' }));
    const result = await makeClient(fetchImpl).stopChildAgent('child-1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('agent.platform.rate_limited');
    expect(result.error.retryable).toBe(true);
  });

  it('a call that outlives the configured timeout maps to a retryable timeout error', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
    const result = await makeClient(fetchImpl, makeLogger(), 100).getChildStatus('child-1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('agent.platform.timeout');
    expect(result.error.retryable).toBe(true);
  });

  it('a network failure maps to a retryable unreachable error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await makeClient(fetchImpl).messageChildAgent('child-1', 'hello');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('agent.platform.unreachable');
    expect(result.error.retryable).toBe(true);
  });

  it('a success with an unexpected body shape maps to an invalid-response error', async () => {
    const fetchImpl = fetchReturning(jsonResponse(201, { unexpected: true }));
    const result = await makeClient(fetchImpl).createChildAgent({ name: 'Research child', prompt: 'Summarise.' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('agent.platform.invalid_response');
  });

  it('never logs the agent key on failure paths', async () => {
    const logger = makeLogger();
    const failures = [
      fetchReturning(jsonResponse(403, { error: 'forbidden', echo: API_KEY })),
      fetchReturning(jsonResponse(500, { error: 'boom', echo: API_KEY })),
      vi.fn(async () => {
        throw new TypeError(`network down ${API_KEY}`);
      }),
    ];
    for (const fetchImpl of failures) {
      await makeClient(fetchImpl, logger).getOwnAllowance();
    }

    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(API_KEY);
  });

  it('createAgentPlatformClientFromEnv returns undefined when the key is missing', () => {
    const logger = makeLogger();
    const client = createAgentPlatformClientFromEnv(
      { API_BASE_URL: BASE_URL, AGENT_ID: AGENT_ID, AGENT_PLATFORM_TIMEOUT_MS: '5000' },
      logger,
    );

    expect(client).toBeUndefined();
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('AGENT_API_KEY');
  });

  it('createAgentPlatformClientFromEnv builds a client from a complete container environment', () => {
    const client = createAgentPlatformClientFromEnv({
      API_BASE_URL: BASE_URL,
      AGENT_API_KEY: API_KEY,
      AGENT_ID: AGENT_ID,
      AGENT_PLATFORM_TIMEOUT_MS: '5000',
    });

    expect(client).toBeDefined();
  });
});

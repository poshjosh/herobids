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

  it('reads the stop switch of its own agent with the agent key', async () => {
    const fetchImpl = fetchReturning(jsonResponse(200, { paused: true }));

    const result = await makeClient(fetchImpl).getPeerMessagingState();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE_URL}/agents/${AGENT_ID}/peer-messaging`);
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}` });
    expect(result).toEqual({ ok: true, data: { paused: true } });
  });

  it.each([
    ['a body without the flag', { state: 'on' }],
    ['a flag that is not a boolean', { paused: 'no' }],
  ])('reads the stop switch from %s as an invalid response, never as open', async (_label, body) => {
    const result = await makeClient(fetchReturning(jsonResponse(200, body))).getPeerMessagingState();

    expect(result).toMatchObject({ ok: false, error: { code: 'agent.platform.invalid_response' } });
  });

  it('forwards only name, prompt, skillIds, connectionIds and start when creating a child', async () => {
    const fetchImpl = fetchReturning(jsonResponse(201, {
      id: 'child-1', depth: 1, status: 'starting', duplicate: false, started: true, startError: null, creatorId: 'ignored',
    }));
    const result = await makeClient(fetchImpl).createChildAgent({
      name: 'Research child',
      prompt: 'Summarise the market.',
      skillIds: ['skill-1'],
      start: true,
    });

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Research child',
      prompt: 'Summarise the market.',
      skillIds: ['skill-1'],
      start: true,
    });
    expect(result).toEqual({ ok: true, data: { id: 'child-1', depth: 1, status: 'starting', duplicate: false, started: true, startError: null } });
  });

  it('reads a duplicate create as the existing child with duplicate true and started false', async () => {
    const body = { id: 'child-1', depth: 1, status: 'stopped', duplicate: true, started: false, startError: null };
    const result = await makeClient(fetchReturning(jsonResponse(200, body))).createChildAgent({
      name: 'Research child', prompt: 'Summarise.', start: true,
    });

    expect(result).toEqual({ ok: true, data: body });
  });

  it('a create reply without the duplicate flag is an invalid response', async () => {
    const body = { id: 'child-1', depth: 1, status: 'stopped', started: false, startError: null };
    const result = await makeClient(fetchReturning(jsonResponse(201, body))).createChildAgent({
      name: 'Research child', prompt: 'Summarise.', start: false,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'agent.platform.invalid_response' } });
  });

  it('reads the last start refusal on a child status, and null when there is none', async () => {
    const refusal = { code: 'billing.limit_exceeded', message: 'Usage limit reached — agent session start blocked', at: '2026-10-26T10:00:00.000Z' };
    const status = { id: 'child-1', name: 'Research', status: 'stopped', depth: 1, runtimeStatus: null, childAgentLimit: 0, lastStartRefusal: refusal };

    const refused = await makeClient(fetchReturning(jsonResponse(200, status))).getChildStatus('child-1');
    const clear = await makeClient(fetchReturning(jsonResponse(200, { ...status, lastStartRefusal: null }))).getChildStatus('child-1');

    expect(refused).toEqual({ ok: true, data: status });
    expect(clear).toMatchObject({ ok: true, data: { lastStartRefusal: null } });
  });

  it('reads a refused start as created-but-not-started, with the namespaced code and message', async () => {
    const body = {
      id: 'child-1',
      depth: 1,
      status: 'stopped',
      duplicate: false,
      started: false,
      startError: { code: 'agent.model_selection_incomplete', message: 'Agent cannot start.' },
    };
    const result = await makeClient(fetchReturning(jsonResponse(201, body))).createChildAgent({
      name: 'Research child', prompt: 'Summarise.', start: true,
    });

    expect(result).toEqual({ ok: true, data: body });
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
    const createAgentTool = agentCreationTools.find((t) => t.name === 'create_child_agent')!;
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
    const result = await makeClient(fetchImpl).createChildAgent({ name: 'Research child', prompt: 'Summarise.', start: true });

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

describe('agent platform client — child listing and deletion', () => {
  it('lists the direct children from the agent-scoped children route', async () => {
    const children = [{ id: 'child-1', name: 'Research', status: 'stopped', depth: 1, childCount: 0, lastStartRefusal: null }];
    const fetchImpl = fetchReturning(jsonResponse(200, { children }));
    const result = await makeClient(fetchImpl).listChildAgents();

    expect(result).toEqual({ ok: true, data: children });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE_URL}/agents/${AGENT_ID}/children`);
    expect(init?.method).toBe('GET');
  });

  it('an empty children list is a valid answer', async () => {
    const result = await makeClient(fetchReturning(jsonResponse(200, { children: [] }))).listChildAgents();

    expect(result).toEqual({ ok: true, data: [] });
  });

  it('a malformed children list maps to an invalid-response error', async () => {
    const result = await makeClient(fetchReturning(jsonResponse(200, { children: [{ id: 'c' }] }))).listChildAgents();

    expect(result).toMatchObject({ ok: false, error: { code: 'agent.platform.invalid_response' } });
  });

  it('deletes one child with DELETE on the agent-scoped child route, sending stopFirst and no body', async () => {
    const fetchImpl = fetchReturning(jsonResponse(200, { deleted: true, stopped: true }));
    const result = await makeClient(fetchImpl).deleteChildAgent('child-1', true);

    expect(result).toEqual({ ok: true, data: { deleted: true, stopped: true } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE_URL}/agents/${AGENT_ID}/children/child-1?stopFirst=true`);
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBeUndefined();
  });

  it('sends stopFirst=false when the caller refuses to stop a running child', async () => {
    const fetchImpl = fetchReturning(jsonResponse(200, { deleted: true, stopped: false }));
    await makeClient(fetchImpl).deleteChildAgent('child-1', false);

    const [url] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE_URL}/agents/${AGENT_ID}/children/child-1?stopFirst=false`);
  });

  it('a refused delete reaches the model as the namespaced code and never the key', async () => {
    const fetchImpl = fetchReturning(jsonResponse(409, { error: 'agent.child.has_children' }));
    const result = await makeClient(fetchImpl).deleteChildAgent('child-1', true);

    expect(result).toMatchObject({ ok: false, error: { code: 'agent.child.has_children' } });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });
});


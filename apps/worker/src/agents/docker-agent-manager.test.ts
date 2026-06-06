import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DockerAgentManager } from './docker-agent-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentRepo() {
  return {
    updateAgent: vi.fn().mockResolvedValue(undefined),
    listActiveAgents: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn().mockResolvedValue(null),
  };
}

const BASE_CONFIG = {
  dockerHost: 'http://docker-proxy:2375',
  dockerNetwork: 'herobids_default',
  agentImage: 'herobids-agent:latest',
  redisUrl: 'redis://localhost:6379',
};

const SPEC = {
  agentId: 'agent-001',
  sessionId: 'sess-001',
  agentConfig: { goal: 'test' },
  toolPolicy: {},
};

/** Produce a fetch mock that handles the three Docker API calls start() issues. */
function makeFetchForStart(containerId = 'container-abc') {
  return vi.fn().mockImplementation((url: string, _init: RequestInit) => {
    // GET /containers/<name>/json — 404 so no stopped-container removal needed
    if (url.includes('/json') && !url.includes('events') && typeof url === 'string') {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    // POST /containers/create
    if (url.includes('/create')) {
      return Promise.resolve(
        new Response(JSON.stringify({ Id: containerId }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    // POST /containers/<id>/start
    if (url.includes(`/${containerId}/start`)) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
}

// ---------------------------------------------------------------------------
// Bug #19 — DockerAgentManager: TCP URL normalization
//
// DOCKER_HOST=tcp://docker-proxy:2375 was converted to http://tcp://docker-proxy:2375
// by the original startsWith('http') guard, causing DNS lookup for hostname "tcp".
// ---------------------------------------------------------------------------
describe('DockerAgentManager — TCP URL normalization (bug #19)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('converts tcp:// scheme to http://', async () => {
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(
      { ...BASE_CONFIG, dockerHost: 'tcp://docker-proxy:2375' },
      makeAgentRepo() as any,
    );
    await manager.start(SPEC);

    const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    for (const url of calledUrls) {
      expect(url).toMatch(/^http:\/\/docker-proxy:2375/);
      expect(url).not.toMatch(/^http:\/\/tcp:/);
    }
  });

  it('does not double-prefix an http:// host', async () => {
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(
      { ...BASE_CONFIG, dockerHost: 'http://docker-proxy:2375' },
      makeAgentRepo() as any,
    );
    await manager.start(SPEC);

    const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    for (const url of calledUrls) {
      expect(url).toMatch(/^http:\/\/docker-proxy:2375/);
    }
  });

  it('prefixes http:// to a bare host:port', async () => {
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(
      { ...BASE_CONFIG, dockerHost: 'docker-proxy:2375' },
      makeAgentRepo() as any,
    );
    await manager.start(SPEC);

    const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    for (const url of calledUrls) {
      expect(url).toMatch(/^http:\/\/docker-proxy:2375/);
    }
  });

  it('preserves https:// scheme unchanged', async () => {
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(
      { ...BASE_CONFIG, dockerHost: 'https://docker-tls-proxy:2376' },
      makeAgentRepo() as any,
    );
    await manager.start(SPEC);

    const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    for (const url of calledUrls) {
      expect(url).toMatch(/^https:\/\/docker-tls-proxy:2376/);
    }
  });

  it('tcp:// URL does NOT produce the broken http://tcp://... form', async () => {
    // This is the exact broken URL that caused getaddrinfo ENOTFOUND tcp.
    // We verify the manager never constructs it.
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(
      { ...BASE_CONFIG, dockerHost: 'tcp://docker-proxy:2375' },
      makeAgentRepo() as any,
    );
    await manager.start(SPEC);

    const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    for (const url of calledUrls) {
      expect(url).not.toContain('http://tcp://');
    }
  });
});

// ---------------------------------------------------------------------------
// Bug #22 — LLM vars forwarded to agent container
//
// LLM_PROVIDER (from config) and LLM_API_KEY_* (from process.env) were absent
// from the container env, causing the agent to start with no LLM credentials.
// ---------------------------------------------------------------------------
describe('DockerAgentManager — LLM env forwarding (bug #22)', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    // Snapshot vars we will mutate
    for (const key of ['LLM_API_KEY', 'LLM_API_KEY_OPENROUTER', 'LLM_API_KEY_ANTHROPIC', 'LLM_API_KEY_OPENAI']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  function getContainerEnv(fetchMock: ReturnType<typeof vi.fn>): string[] {
    // The POST /containers/create call carries the body with Env array
    const createCall = fetchMock.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('/create'),
    );
    if (!createCall) return [];
    const init = createCall[1] as RequestInit;
    const body = JSON.parse(init.body as string) as { Env: string[] };
    return body.Env;
  }

  it('includes LLM_PROVIDER in container env when configured', async () => {
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(
      { ...BASE_CONFIG, llmProvider: 'openrouter' },
      makeAgentRepo() as any,
    );
    await manager.start(SPEC);

    const env = getContainerEnv(fetchMock);
    expect(env).toContain('LLM_PROVIDER=openrouter');
  });

  it('omits LLM_PROVIDER from container env when not configured', async () => {
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(
      BASE_CONFIG, // no llmProvider
      makeAgentRepo() as any,
    );
    await manager.start(SPEC);

    const env = getContainerEnv(fetchMock);
    expect(env.some((e: string) => e.startsWith('LLM_PROVIDER='))).toBe(false);
  });

  it('forwards LLM_API_KEY_OPENROUTER from process.env', async () => {
    process.env['LLM_API_KEY_OPENROUTER'] = 'sk-or-test-key';
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(
      { ...BASE_CONFIG, llmProvider: 'openrouter' },
      makeAgentRepo() as any,
    );
    await manager.start(SPEC);

    const env = getContainerEnv(fetchMock);
    expect(env).toContain('LLM_API_KEY_OPENROUTER=sk-or-test-key');
  });

  it('forwards LLM_API_KEY_ANTHROPIC from process.env', async () => {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'sk-ant-test-key';
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(
      { ...BASE_CONFIG, llmProvider: 'anthropic' },
      makeAgentRepo() as any,
    );
    await manager.start(SPEC);

    const env = getContainerEnv(fetchMock);
    expect(env).toContain('LLM_API_KEY_ANTHROPIC=sk-ant-test-key');
  });

  it('forwards LLM_API_KEY_OPENAI from process.env', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'sk-openai-test-key';
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(BASE_CONFIG, makeAgentRepo() as any);
    await manager.start(SPEC);

    const env = getContainerEnv(fetchMock);
    expect(env).toContain('LLM_API_KEY_OPENAI=sk-openai-test-key');
  });

  it('forwards generic LLM_API_KEY from process.env', async () => {
    process.env['LLM_API_KEY'] = 'sk-generic-key';
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(BASE_CONFIG, makeAgentRepo() as any);
    await manager.start(SPEC);

    const env = getContainerEnv(fetchMock);
    expect(env).toContain('LLM_API_KEY=sk-generic-key');
  });

  it('omits API key env vars when not present in process.env', async () => {
    // All API key env vars were deleted in beforeEach
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(BASE_CONFIG, makeAgentRepo() as any);
    await manager.start(SPEC);

    const env = getContainerEnv(fetchMock);
    expect(env.some((e: string) => e.startsWith('LLM_API_KEY'))).toBe(false);
  });

  it('includes LLM_MODEL in container env when configured', async () => {
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(
      { ...BASE_CONFIG, llmModel: 'claude-sonnet-4-5', llmProvider: 'openrouter' },
      makeAgentRepo() as any,
    );
    await manager.start(SPEC);

    const env = getContainerEnv(fetchMock);
    expect(env).toContain('LLM_MODEL=claude-sonnet-4-5');
    // Model name starting with 'claude' must NOT cause provider to change — provider
    // comes from config, not from model inference (the removed bug #22 behaviour).
    expect(env).toContain('LLM_PROVIDER=openrouter');
  });

  it('includes LLM_BASE_URL in container env when configured', async () => {
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(
      { ...BASE_CONFIG, llmBaseUrl: 'https://openrouter.ai/api/v1', llmProvider: 'openrouter' },
      makeAgentRepo() as any,
    );
    await manager.start(SPEC);

    const env = getContainerEnv(fetchMock);
    expect(env).toContain('LLM_BASE_URL=https://openrouter.ai/api/v1');
  });
});

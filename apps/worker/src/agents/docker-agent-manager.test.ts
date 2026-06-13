import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DockerAgentManager } from './docker-agent-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentRepo() {
  return {
    updateAgent: vi.fn().mockResolvedValue(undefined),
    listActiveAgents: vi.fn().mockResolvedValue([]),
    getSessionsByStatuses: vi.fn().mockResolvedValue([]),
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

// ---------------------------------------------------------------------------
// Reconcile — orphan container detection
//
// A container may be running while the agents table has no matching active row.
// This happens when the DB is truncated/re-seeded while containers keep running,
// or when a container is launched outside the API provisioning flow.
// The reconcile loop should stop such orphan containers and log a warning.
// ---------------------------------------------------------------------------
describe('DockerAgentManager — reconcile orphan detection', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function makeReconcileFetch(options: {
    runningAgentIds: string[];
    stopStatus?: number;
  }) {
    const { runningAgentIds, stopStatus = 204 } = options;
    return vi.fn().mockImplementation((url: string, _init: RequestInit) => {
      if (url.includes('/containers/json')) {
        const containers = runningAgentIds.map((id) => ({
          Names: [`/herobids-agent-${id}`],
          State: 'running',
          Labels: { 'herobids.role': 'agent', 'herobids.agentId': id },
        }));
        return Promise.resolve(new Response(JSON.stringify(containers), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.includes('/stop')) {
        return Promise.resolve(new Response(null, { status: stopStatus }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
  }

  it('stops a container running with no active agent row in DB', async () => {
    const agentRepo = makeAgentRepo(); // listActiveAgents returns [] — no known active agents
    const fetchMock = makeReconcileFetch({ runningAgentIds: ['orphan-001'] });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(BASE_CONFIG as any, agentRepo as any);
    await manager.reconcile();

    const stopCall = fetchMock.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('/stop'),
    );
    expect(stopCall).toBeDefined();
    expect(stopCall![0] as string).toContain('herobids-agent-orphan-001');
  });

  it('does not stop a container that has a matching active agent row', async () => {
    const agentRepo = makeAgentRepo();
    (agentRepo.listActiveAgents as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'agent-001', status: 'active' }]);
    const fetchMock = makeReconcileFetch({ runningAgentIds: ['agent-001'] });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(BASE_CONFIG as any, agentRepo as any);
    await manager.reconcile();

    const stopCall = fetchMock.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('/stop'),
    );
    expect(stopCall).toBeUndefined();
  });

  it('does not stop a container whose runtime session is still starting', async () => {
    const agentRepo = makeAgentRepo();
    (agentRepo.getSessionsByStatuses as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-starting', status: 'starting' },
    ]);
    const fetchMock = makeReconcileFetch({ runningAgentIds: ['agent-starting'] });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(BASE_CONFIG as any, agentRepo as any);
    await manager.reconcile();

    const stopCall = fetchMock.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('/stop'),
    );
    expect(stopCall).toBeUndefined();
  });

  it('stops only orphan containers when some have active rows and some do not', async () => {
    const agentRepo = makeAgentRepo();
    (agentRepo.listActiveAgents as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'agent-known', status: 'active' }]);
    const fetchMock = makeReconcileFetch({ runningAgentIds: ['agent-known', 'agent-orphan'] });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(BASE_CONFIG as any, agentRepo as any);
    await manager.reconcile();

    const stopCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('/stop'),
    );
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]![0] as string).toContain('agent-orphan');
  });

  it('continues reconciliation when stopping an orphan fails', async () => {
    const agentRepo = makeAgentRepo();
    const fetchMock = makeReconcileFetch({ runningAgentIds: ['orphan-fail'], stopStatus: 500 });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(BASE_CONFIG as any, agentRepo as any);
    // Should not throw even if the Docker stop call fails
    await expect(manager.reconcile()).resolves.not.toThrow();
  });
});

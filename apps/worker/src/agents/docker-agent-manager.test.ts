import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DockerAgentManager } from './docker-agent-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentRepo() {
  return {
    updateAgent: vi.fn().mockResolvedValue(undefined),
    updateSession: vi.fn().mockResolvedValue(undefined),
    retireActiveSessionsWithStatus: vi.fn().mockResolvedValue(undefined),
    listActiveAgents: vi.fn().mockResolvedValue([]),
    getSessionsByStatuses: vi.fn().mockResolvedValue([]),
    getCurrentSession: vi.fn().mockResolvedValue(null),
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

  it('stops an existing running container before create', async () => {
    const containerId = 'container-abc';
    const fetchMock = vi.fn().mockImplementation((url: string, _init: RequestInit) => {
      if (url.includes('/json') && !url.includes('events')) {
        return Promise.resolve(new Response(JSON.stringify({ State: { Running: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.includes('/stop')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.includes('/containers/') && !url.includes('/json') && !url.includes('/create') && !url.includes('/start') && !url.includes('/stop')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.includes('/create')) {
        return Promise.resolve(
          new Response(JSON.stringify({ Id: containerId }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes(`/${containerId}/start`)) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(
      { ...BASE_CONFIG, dockerHost: 'tcp://docker-proxy:2375' },
      makeAgentRepo() as any,
    );
    await manager.start(SPEC);

    const urls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    const stopIndex = urls.findIndex((u) => u.includes('/stop'));
    const deleteIndex = urls.findIndex((u) => u.includes('/containers/') && !u.includes('/json') && !u.includes('/create') && !u.includes('/start') && !u.includes('/stop'));
    const createIndex = urls.findIndex((u) => u.includes('/create'));

    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeLessThan(deleteIndex);
    expect(deleteIndex).toBeLessThan(createIndex);
  });

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

describe('DockerAgentManager — stop failure recovery', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reverts the agent status when Docker stop throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket closed'));
    vi.stubGlobal('fetch', fetchMock);

    const agentRepo = makeAgentRepo();
    const manager = new DockerAgentManager(BASE_CONFIG, agentRepo as any);

    await expect(manager.stop('agent-001')).rejects.toThrow('socket closed');

    expect(agentRepo.updateAgent).toHaveBeenNthCalledWith(1, 'agent-001', { status: 'stopped' });
    expect(agentRepo.updateAgent).toHaveBeenNthCalledWith(2, 'agent-001', { status: 'crashed' });
  });
});

describe('DockerAgentManager — sandbox capabilities (bug #10)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('grants NET_ADMIN and SYS_ADMIN to agent containers', async () => {
    const fetchMock = makeFetchForStart();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new DockerAgentManager(BASE_CONFIG, makeAgentRepo() as any);
    await manager.start(SPEC);

    const createCall = fetchMock.mock.calls.find((call: unknown[]) =>
      typeof call[0] === 'string' && (call[0] as string).includes('/create'),
    );
    expect(createCall).toBeDefined();

    const init = createCall?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      HostConfig?: { CapAdd?: string[] };
    };

    expect(body.HostConfig?.CapAdd).toEqual(['NET_ADMIN', 'SYS_ADMIN']);
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

describe('DockerAgentManager — session-aware container death', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('ignores stale container exits from a superseded session', async () => {
    const agentRepo = makeAgentRepo();
    (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'agent-001', status: 'active' });
    (agentRepo.getCurrentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sess-new', agentId: 'agent-001', status: 'running' });

    const manager = new DockerAgentManager(BASE_CONFIG as any, agentRepo as any);

    await manager.onContainerDie('agent-001', 'docker_event', 'sess-old');

    expect(agentRepo.updateSession).not.toHaveBeenCalled();
    expect(agentRepo.updateAgent).not.toHaveBeenCalled();
  });

  it('crashes only the current session when its container dies', async () => {
    const agentRepo = makeAgentRepo();
    (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'agent-001', status: 'active' });
    (agentRepo.getCurrentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sess-001', agentId: 'agent-001', status: 'running' });

    const manager = new DockerAgentManager(BASE_CONFIG as any, agentRepo as any);

    await manager.onContainerDie('agent-001', 'docker_event', 'sess-001');

    expect(agentRepo.retireActiveSessionsWithStatus).toHaveBeenCalledWith('agent-001', 'crashed', expect.any(Date));
    expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-001', { status: 'crashed' });
  });

  it('skips duplicate crash handling after a crashed runtime already retired its session', async () => {
    const agentRepo = makeAgentRepo();
    (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'agent-001', status: 'crashed' });
    (agentRepo.getCurrentSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const manager = new DockerAgentManager(BASE_CONFIG as any, agentRepo as any);

    await manager.onContainerDie('agent-001', 'docker_event', 'sess-001');

    expect(agentRepo.retireActiveSessionsWithStatus).not.toHaveBeenCalled();
    expect(agentRepo.updateAgent).not.toHaveBeenCalled();
  });

  it('preserves stopped status when Docker die arrives after a graceful session_ended (ordering regression)', async () => {
    // Regression guard for the mismatch bug: the agent runtime sends session_ended (status='stopped')
    // before its container exits. Docker then fires a die event. The die handler must not
    // reclassify the graceful stop as a crash.
    //
    // After session_ended: agent.status = 'stopped', getCurrentSession = null (terminal session).
    // Die event must be a no-op — crash handling is skipped, status stays 'stopped'.
    const agentRepo = makeAgentRepo();
    (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'agent-001', status: 'stopped' });
    (agentRepo.getCurrentSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const manager = new DockerAgentManager(BASE_CONFIG as any, agentRepo as any);

    await manager.onContainerDie('agent-001', 'docker_event', 'sess-001');

    // Neither crash retirement nor agent status update should run
    expect(agentRepo.retireActiveSessionsWithStatus).not.toHaveBeenCalled();
    expect(agentRepo.updateAgent).not.toHaveBeenCalled();
  });
});

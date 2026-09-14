import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvidenceAssemblyContext, EvidenceManifest, AgentEvidencePort } from './evidence-assembler.js';
import type { EvaluationArtifactStore, EvaluationArtifactRef } from '@herobids/domain';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockGetAgent = vi.fn();
const mockAgentRepoConstructor = vi.fn(function (this: unknown) {
  return { getAgent: mockGetAgent };
});

const mockCollectContainerLogs = vi.fn();

// Only the PLATFORM-local reads stay on the @herobids/db loaders: runtime
// sessions, agent metadata (AgentRepository), and billing usage events.
// Fills / journal / positions now come over the AgentEvidencePort.
vi.mock('@herobids/db', () => ({
  AgentRepository: mockAgentRepoConstructor,
  loadAgentRuntimeSessions: vi.fn().mockResolvedValue([]),
  billingUsageEvents: {
    meterKey: 'meter_key',
    quantity: 'quantity',
    unit: 'unit',
    agentId: 'agent_id',
    occurredAt: 'occurred_at',
  },
}));

vi.mock('./container-logs.js', () => ({
  collectContainerLogs: mockCollectContainerLogs,
}));

const { assembleEvidence } = await import('./evidence-assembler.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeStore(): { store: EvaluationArtifactStore; written: Map<string, string> } {
  const written = new Map<string, string>();
  const store: EvaluationArtifactStore = {
    write: vi.fn(
      async (_runId: string, name: string, content: Uint8Array | string): Promise<EvaluationArtifactRef> => {
        const str = typeof content === 'string' ? content : new TextDecoder().decode(content);
        written.set(name, str);
        return { name, mimeType: 'application/json', sizeBytes: new TextEncoder().encode(str).byteLength };
      },
    ),
    read: vi.fn(async (_runId: string, name: string) => {
      const content = written.get(name);
      if (content === undefined) return null;
      return new TextEncoder().encode(content);
    }),
    list: vi.fn(async () => []),
  };
  return { store, written };
}

function mockDb() {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockResolvedValue([]),
  };
  return {
    select: vi.fn(() => chain),
    ...chain,
  } as unknown as ReturnType<typeof mockDb>;
}

function makeEvidencePort(overrides?: Partial<AgentEvidencePort>): AgentEvidencePort {
  return {
    getFills: vi.fn().mockResolvedValue([]),
    getJournalEvents: vi.fn().mockResolvedValue([]),
    getPositions: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeContext(overrides?: Partial<EvidenceAssemblyContext>): EvidenceAssemblyContext {
  return {
    db: mockDb(),
    agentId: 'agent-test-1',
    scope: { type: 'session', sessionId: 'sess-1' },
    store: makeStore().store,
    runId: 'run-test-1',
    agentEvidencePort: makeEvidencePort(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('assembleEvidence — unified-agent-config.json', () => {
  beforeEach(() => {
    mockGetAgent.mockReset();
    mockCollectContainerLogs.mockReset().mockResolvedValue({
      artifactName: 'container-logs.txt',
      collected: false,
      error: 'Container logs unavailable',
    });
  });

  it('writes unified-agent-config.json when agent exists with non-null unifiedConfig', async () => {
    const unifiedConfig = { technical: { leverage: 2 }, execution: { mode: 'paper' } };
    mockGetAgent.mockResolvedValue({
      id: 'agent-test-1',
      name: 'Test Agent',
      status: 'stopped',
      style: 'balanced',
      executionMode: 'paper',
      dailyLossLimit: null,
      maxBots: null,
      maxSlippageBps: null,
      createdAt: new Date(),
      unifiedConfig,
    });

    const { store, written } = makeStore();
    const ctx = makeContext({ store });

    const manifest = await assembleEvidence(ctx);

    // Manifest records collected
    const entry = manifest.entries.find((e) => e.artifactName === 'unified-agent-config.json');
    expect(entry).toBeDefined();
    expect(entry!.collected).toBe(true);

    // Content equals the persisted unified config
    const raw = written.get('unified-agent-config.json');
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual(unifiedConfig);
  });

  it('writes unified-agent-config.json as JSON null when agent exists but unifiedConfig is null', async () => {
    mockGetAgent.mockResolvedValue({
      id: 'agent-test-1',
      name: 'Test Agent',
      status: 'stopped',
      style: null,
      executionMode: 'paper',
      dailyLossLimit: null,
      maxBots: null,
      maxSlippageBps: null,
      createdAt: new Date(),
      unifiedConfig: null,
    });

    const { store, written } = makeStore();
    const ctx = makeContext({ store });

    const manifest = await assembleEvidence(ctx);

    // Manifest records collected
    const entry = manifest.entries.find((e) => e.artifactName === 'unified-agent-config.json');
    expect(entry).toBeDefined();
    expect(entry!.collected).toBe(true);

    // Content is JSON null
    const raw = written.get('unified-agent-config.json');
    expect(raw).toBeDefined();
    expect(raw!.trim()).toBe('null');
  });

  it('records unified-agent-config.json as not collected when agent row is unavailable', async () => {
    mockGetAgent.mockResolvedValue(null);

    const { store } = makeStore();
    const ctx = makeContext({ store });

    const manifest = await assembleEvidence(ctx);

    const entry = manifest.entries.find((e) => e.artifactName === 'unified-agent-config.json');
    expect(entry).toBeDefined();
    expect(entry!.collected).toBe(false);
    expect(entry!.error).toBe('Agent not found');
  });

  it('records unified-agent-config.json as not collected on AgentRepository error', async () => {
    mockGetAgent.mockRejectedValue(new Error('DB connection refused'));

    const { store } = makeStore();
    const ctx = makeContext({ store });

    const manifest = await assembleEvidence(ctx);

    const entry = manifest.entries.find((e) => e.artifactName === 'unified-agent-config.json');
    expect(entry).toBeDefined();
    expect(entry!.collected).toBe(false);
    expect(entry!.error).toContain('DB connection refused');
  });

  it('keeps unified-agent-config.json best-effort when persisting that artifact fails', async () => {
    mockGetAgent.mockResolvedValue({
      id: 'agent-test-1',
      name: 'Test Agent',
      status: 'stopped',
      style: 'balanced',
      executionMode: 'paper',
      dailyLossLimit: null,
      maxBots: null,
      maxSlippageBps: null,
      createdAt: new Date(),
      unifiedConfig: { technical: { leverage: 2 } },
    });

    const { store } = makeStore();
    const originalWrite = store.write;
    store.write = vi.fn(async (runId: string, name: string, content: Uint8Array | string) => {
      if (name === 'unified-agent-config.json') {
        throw new Error('disk full');
      }
      return originalWrite(runId, name, content);
    });

    const ctx = makeContext({ store });

    const manifest = await assembleEvidence(ctx);

    const entry = manifest.entries.find((e) => e.artifactName === 'unified-agent-config.json');
    expect(entry).toBeDefined();
    expect(entry!.collected).toBe(false);
    expect(entry!.error).toContain('disk full');

    const fillsEntry = manifest.entries.find((e) => e.artifactName === 'fills.json');
    expect(fillsEntry).toBeDefined();
    expect(fillsEntry!.collected).toBe(true);
  });

  it('does not crash the assembler when AgentRepository throws', async () => {
    mockGetAgent.mockRejectedValue(new Error('DB connection refused'));

    const { store } = makeStore();
    const ctx = makeContext({ store });

    // Should not throw — agent metadata is best-effort
    const manifest = await assembleEvidence(ctx);
    expect(manifest.entries).toBeDefined();
    expect(manifest.entries.length).toBeGreaterThan(0);

    // Core evidence still collected
    const fillsEntry = manifest.entries.find((e) => e.artifactName === 'fills.json');
    expect(fillsEntry).toBeDefined();
    expect(fillsEntry!.collected).toBe(true);
  });
});

describe('assembleEvidence — agent evidence port', () => {
  beforeEach(() => {
    mockGetAgent.mockReset().mockResolvedValue(null);
    mockCollectContainerLogs.mockReset().mockResolvedValue({
      artifactName: 'container-logs.txt',
      collected: false,
      error: 'Container logs unavailable',
    });
  });

  it('writes fills/journal/positions from the port with matching item counts', async () => {
    const fills = [{ id: 'f1' }, { id: 'f2' }];
    const journal = [{ id: 'j1' }];
    const positions = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    const port = makeEvidencePort({
      getFills: vi.fn().mockResolvedValue(fills),
      getJournalEvents: vi.fn().mockResolvedValue(journal),
      getPositions: vi.fn().mockResolvedValue(positions),
    });

    const { store, written } = makeStore();
    const ctx = makeContext({ store, agentEvidencePort: port });

    const manifest = await assembleEvidence(ctx);

    expect(JSON.parse(written.get('fills.json')!)).toEqual(fills);
    expect(JSON.parse(written.get('journal.json')!)).toEqual(journal);
    expect(JSON.parse(written.get('positions.json')!)).toEqual(positions);

    expect(manifest.entries.find((e) => e.artifactName === 'fills.json')!.itemCount).toBe(2);
    expect(manifest.entries.find((e) => e.artifactName === 'journal.json')!.itemCount).toBe(1);
    expect(manifest.entries.find((e) => e.artifactName === 'positions.json')!.itemCount).toBe(3);
  });

  it('passes resolved time bounds to the port for a timeRange scope', async () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');
    const port = makeEvidencePort();

    const { store } = makeStore();
    const ctx = makeContext({ store, agentEvidencePort: port, scope: { type: 'timeRange', from, to } });

    await assembleEvidence(ctx);

    expect(port.getFills).toHaveBeenCalledWith({ from, to });
    expect(port.getJournalEvents).toHaveBeenCalledWith({ from, to });
    // positions uses the `at` snapshot (scope end), not from/to
    expect(port.getPositions).toHaveBeenCalledWith({ at: to });
  });

  it('propagates a port failure — core evidence must succeed (throws)', async () => {
    const port = makeEvidencePort({
      getFills: vi.fn().mockRejectedValue(new Error('boundary unavailable')),
    });

    const { store } = makeStore();
    const ctx = makeContext({ store, agentEvidencePort: port });

    await expect(assembleEvidence(ctx)).rejects.toThrow('boundary unavailable');
  });
});

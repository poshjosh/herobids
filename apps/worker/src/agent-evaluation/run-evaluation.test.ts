import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EvaluationArtifactRef,
  EvaluationArtifactStore,
  EvaluationSectionScore,
  EvaluationThresholds,
} from '@herobids/domain';

const mockMarkSucceeded = vi.fn();
const mockMarkFailed = vi.fn();
const mockMarkRetrying = vi.fn();
const mockAssembleEvidence = vi.fn();
const mockAnalyzeSecurity = vi.fn();
const mockAnalyzeCore = vi.fn();
const mockAnalyzeTrading = vi.fn();
const mockRenderReport = vi.fn();
const mockGenerateEvaluationNarrative = vi.fn();
const mockRedact = vi.fn((text: string) => `redacted:${text}`);
const mockRedactJson = vi.fn((value: unknown) => ({ redacted: true, value }));

vi.mock('@herobids/db', () => ({
  agentRuntimeSessions: {
    id: 'id',
    startedAt: 'started_at',
    stoppedAt: 'stopped_at',
  },
  FsEvaluationArtifactStore: vi.fn(),
  markSucceeded: mockMarkSucceeded,
  markFailed: mockMarkFailed,
  markRetrying: mockMarkRetrying,
  agents: {
    id: 'id',
    userId: 'user_id',
  },
  billingAccounts: {
    id: 'id',
    ownerUserId: 'owner_user_id',
  },
}));

vi.mock('./collectors/evidence-assembler.js', () => ({
  assembleEvidence: mockAssembleEvidence,
}));

vi.mock('./analyzers/security.js', () => ({
  analyzeSecurity: mockAnalyzeSecurity,
}));

vi.mock('./analyzers/core.js', () => ({
  analyzeCore: mockAnalyzeCore,
}));

vi.mock('./analyzers/trading.js', () => ({
  analyzeTrading: mockAnalyzeTrading,
}));

vi.mock('./render-report.js', () => ({
  renderReport: mockRenderReport,
}));

vi.mock('./generate-narrative.js', () => ({
  generateEvaluationNarrative: mockGenerateEvaluationNarrative,
}));

vi.mock('./redaction.js', () => ({
  redact: mockRedact,
  redactJson: mockRedactJson,
}));

const { EVIDENCE_ARTIFACTS_FOR_REDACTION, runEvaluation } = await import('./run-evaluation.js');

function makeArtifactRef(name: string, content: string): EvaluationArtifactRef {
  return {
    name,
    mimeType: name.endsWith('.json') ? 'application/json' : 'text/markdown',
    sizeBytes: new TextEncoder().encode(content).byteLength,
  };
}

function makeStore(
  initialArtifacts: Record<string, string> = {},
): { store: EvaluationArtifactStore; written: Map<string, string> } {
  const written = new Map(Object.entries(initialArtifacts));

  const store: EvaluationArtifactStore = {
    write: vi.fn(async (_runId: string, name: string, content: Uint8Array | string) => {
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
      written.set(name, text);
      return makeArtifactRef(name, text);
    }),
    read: vi.fn(async (_runId: string, name: string) => {
      const text = written.get(name);
      return text == null ? null : new TextEncoder().encode(text);
    }),
    list: vi.fn(async () =>
      Array.from(written.entries()).map(([name, content]) => makeArtifactRef(name, content))),
  };

  return { store, written };
}

function makeSection(section: EvaluationSectionScore['section']): EvaluationSectionScore {
  return {
    section,
    score: 100,
    findings: [],
    applicable: true,
  };
}

const thresholds: EvaluationThresholds = {
  toolFailureRatePct: 20,
  highDrawdownPct: 20,
  negativeExpectancyFlag: true,
  veryShortHoldSec: 30,
  rateLimitAnomalyCount: 5,
  veryShortSessionSec: 60,
};

describe('runEvaluation', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAssembleEvidence.mockImplementation(async ({ store, runId }) => {
      await store.write(runId, 'fills.json', JSON.stringify([{ orderId: 'fill-1' }], null, 2));
      await store.write(runId, 'journal.json', JSON.stringify([{ event: 'decide' }], null, 2));
      await store.write(runId, 'sessions.json', JSON.stringify([{ id: 'session-1' }], null, 2));
      await store.write(runId, 'positions.json', JSON.stringify([{ symbol: 'BTC' }], null, 2));
      await store.write(runId, 'agent-metadata.json', JSON.stringify({ executionMode: 'paper' }, null, 2));
      await store.write(
        runId,
        'unified-agent-config.json',
        JSON.stringify({ technical: { enabled: true } }, null, 2),
      );

      return {
        entries: [
          { artifactName: 'fills.json', collected: true, itemCount: 1 },
          { artifactName: 'journal.json', collected: true, itemCount: 1 },
          { artifactName: 'sessions.json', collected: true, itemCount: 1 },
          { artifactName: 'positions.json', collected: true, itemCount: 1 },
          { artifactName: 'agent-metadata.json', collected: true },
          { artifactName: 'unified-agent-config.json', collected: true },
        ],
        scope: { type: 'allTime' as const },
      };
    });

    mockAnalyzeSecurity.mockResolvedValue(makeSection('security'));
    mockAnalyzeCore.mockResolvedValue([makeSection('session_health')]);
    mockAnalyzeTrading.mockResolvedValue([makeSection('trading_behavior')]);
    mockRenderReport.mockReturnValue('Report body');
    mockGenerateEvaluationNarrative.mockResolvedValue(null);
  });

  it('includes unified-agent-config.json in the redaction pass', () => {
    expect(EVIDENCE_ARTIFACTS_FOR_REDACTION).toContain('unified-agent-config.json');
  });

  it('redacts unified-agent-config.json and persists it in the final artifact manifest', async () => {
    const { store, written } = makeStore();

    await runEvaluation({
      db: {} as never,
      runId: 'run-test-1',
      agentId: 'agent-test-1',
      resolvedScope: { type: 'allTime' },
      includeNarrative: false,
      thresholds,
      store,
      storageRoot: '/tmp/eval-artifacts',
      attemptNumber: 1,
      maxAttempts: 1,
    });

    expect(mockRedactJson).toHaveBeenCalledWith({ technical: { enabled: true } });

    const unifiedConfigArtifact = written.get('unified-agent-config.json');
    expect(unifiedConfigArtifact).toBeDefined();
    expect(JSON.parse(unifiedConfigArtifact ?? 'null')).toEqual({
      redacted: true,
      value: { technical: { enabled: true } },
    });

    expect(written.get('evaluation.json')).toBeDefined();
    expect(written.get('REPORT.md')).toBe('redacted:Report body');

    expect(mockMarkSucceeded).toHaveBeenCalledTimes(1);
    const [, , result] = mockMarkSucceeded.mock.calls[0] as [unknown, unknown, { artifactManifest: EvaluationArtifactRef[] }];
    expect(result.artifactManifest.map((artifact) => artifact.name)).toContain('unified-agent-config.json');
    expect(result.artifactManifest.map((artifact) => artifact.name)).toContain('evaluation.json');
    expect(result.artifactManifest.map((artifact) => artifact.name)).toContain('REPORT.md');

    const persistedEvaluation = JSON.parse(written.get('evaluation.json') ?? '{}') as {
      scope?: { type: string };
      summary?: { totalFindings: number };
    };
    expect(persistedEvaluation.scope).toEqual({ type: 'allTime' });
    expect(persistedEvaluation.summary?.totalFindings).toBe(0);
  });
});

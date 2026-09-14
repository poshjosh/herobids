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

  it('aborts the run (final attempt) when the injected evidence port fails in the assembler', async () => {
    // Make the assembler exercise the port so a boundary failure propagates.
    mockAssembleEvidence.mockImplementationOnce(async (ctx) => {
      await ctx.agentEvidencePort.getFills({});
      return { entries: [], scope: { type: 'allTime' as const } };
    });

    const failingPort = {
      getFills: vi.fn().mockRejectedValue(new Error('boundary unavailable')),
      getJournalEvents: vi.fn(),
      getPositions: vi.fn(),
    };

    const { store } = makeStore();

    await expect(
      runEvaluation({
        db: {} as never,
        runId: 'run-boundary-fail',
        agentId: 'agent-boundary-fail',
        resolvedScope: { type: 'allTime' },
        includeNarrative: false,
        thresholds,
        store,
        storageRoot: '/tmp/eval-artifacts',
        attemptNumber: 1,
        maxAttempts: 1,
        agentEvidencePort: failingPort,
      }),
    ).rejects.toThrow('boundary unavailable');

    expect(failingPort.getFills).toHaveBeenCalledTimes(1);
    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(mockMarkSucceeded).not.toHaveBeenCalled();
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

  it('does not include preset-assessment appendix in REPORT.md when no evidence is present', async () => {
    const { store, written } = makeStore();

    await runEvaluation({
      db: {} as never,
      runId: 'run-test-no-preset',
      agentId: 'agent-test-no-preset',
      resolvedScope: { type: 'allTime' },
      includeNarrative: false,
      thresholds,
      store,
      storageRoot: '/tmp/eval-artifacts',
      attemptNumber: 1,
      maxAttempts: 1,
    });

    const report = written.get('REPORT.md');
    expect(report).toBeDefined();
    expect(report).not.toContain('## Preset Assessment Summary');
  });

  it('writes preset-assessment artifacts and includes appendix in REPORT.md when evidence is present', async () => {
    // Override the assembleEvidence mock for this test to include preset-assessment evidence
    mockAssembleEvidence.mockImplementationOnce(async ({ store, runId }) => {
      await store.write(runId, 'fills.json', JSON.stringify([], null, 2));
      await store.write(runId, 'journal.json', JSON.stringify([], null, 2));
      await store.write(runId, 'sessions.json', JSON.stringify([], null, 2));
      await store.write(runId, 'positions.json', JSON.stringify([], null, 2));
      await store.write(runId, 'agent-metadata.json', JSON.stringify({ executionMode: 'paper' }, null, 2));
      await store.write(
        runId,
        'unified-agent-config.json',
        JSON.stringify({ platformAssessment: { enabled: true } }, null, 2),
      );

      return {
        entries: [
          { artifactName: 'fills.json', collected: true, itemCount: 0 },
          { artifactName: 'journal.json', collected: true, itemCount: 0 },
          { artifactName: 'sessions.json', collected: true, itemCount: 0 },
          { artifactName: 'positions.json', collected: true, itemCount: 0 },
          { artifactName: 'agent-metadata.json', collected: true },
          { artifactName: 'unified-agent-config.json', collected: true },
        ],
        scope: { type: 'allTime' as const },
        presetAssessmentEvidence: {
          reviewAdviceRows: [{ id: 'ra-1', outcome: 'advised', consumedAt: '2026-07-19T12:00:00Z', checkedAt: '2026-07-19T12:00:00Z' }],
          requestRows: [{ id: 'req-1', status: 'cache_hit', requestedAt: '2026-07-19T12:00:00Z', assessmentArtifactId: 'art-1' }],
          transitionRows: [],
          defaultBindingRow: null,
          auditCaveats: [],
          collectedAt: '2026-07-19T12:00:00Z',
        },
      };
    });

    const { store, written } = makeStore();

    await runEvaluation({
      db: {} as never,
      runId: 'run-test-preset',
      agentId: 'agent-test-preset',
      resolvedScope: { type: 'allTime' },
      includeNarrative: false,
      thresholds,
      store,
      storageRoot: '/tmp/eval-artifacts',
      attemptNumber: 1,
      maxAttempts: 1,
    });

    // Verify summary artifact was written
    const summaryRaw = written.get('preset-assessment-summary.json');
    expect(summaryRaw).toBeDefined();
    const summary = JSON.parse(summaryRaw ?? 'null') as { includedInReport: boolean; inclusionReason: string };
    expect(summary.includedInReport).toBe(true);
    expect(summary.inclusionReason).toBe('enabled_and_activity');

    // Verify events artifact was written (wrapped in self-describing envelope)
    const eventsRaw = written.get('preset-assessment-events.json');
    expect(eventsRaw).toBeDefined();
    const eventsArtifact = JSON.parse(eventsRaw ?? '{}') as { events: Array<unknown>; schemaVersion: number; scope: Record<string, unknown> };
    expect(eventsArtifact.events.length).toBeGreaterThan(0);
    expect(eventsArtifact.schemaVersion).toBe(1);
    expect(eventsArtifact.scope).toBeDefined();

    // Verify appendix is in REPORT.md
    const report = written.get('REPORT.md');
    expect(report).toBeDefined();
    expect(report).toContain('## Preset Assessment Summary');

    // Verify artifacts are in the manifest
    expect(mockMarkSucceeded).toHaveBeenCalledTimes(1);
    const [, , result] = mockMarkSucceeded.mock.calls[0] as [unknown, unknown, { artifactManifest: EvaluationArtifactRef[] }];
    const names = result.artifactManifest.map((a) => a.name);
    expect(names).toContain('preset-assessment-summary.json');
    expect(names).toContain('preset-assessment-events.json');
  });

  it('places preset-assessment appendix before ## Commentary when narrative is enabled', async () => {
    mockAssembleEvidence.mockImplementationOnce(async ({ store, runId }) => {
      await store.write(runId, 'fills.json', JSON.stringify([], null, 2));
      await store.write(runId, 'journal.json', JSON.stringify([], null, 2));
      await store.write(runId, 'sessions.json', JSON.stringify([], null, 2));
      await store.write(runId, 'positions.json', JSON.stringify([], null, 2));
      await store.write(runId, 'agent-metadata.json', JSON.stringify({ executionMode: 'paper' }, null, 2));
      await store.write(
        runId,
        'unified-agent-config.json',
        JSON.stringify({ platformAssessment: { enabled: true } }, null, 2),
      );

      return {
        entries: [
          { artifactName: 'fills.json', collected: true, itemCount: 0 },
          { artifactName: 'journal.json', collected: true, itemCount: 0 },
          { artifactName: 'sessions.json', collected: true, itemCount: 0 },
          { artifactName: 'positions.json', collected: true, itemCount: 0 },
          { artifactName: 'agent-metadata.json', collected: true },
          { artifactName: 'unified-agent-config.json', collected: true },
        ],
        scope: { type: 'allTime' as const },
        presetAssessmentEvidence: {
          reviewAdviceRows: [{ id: 'ra-1', outcome: 'advised', consumedAt: '2026-07-19T12:00:00Z', checkedAt: '2026-07-19T12:00:00Z' }],
          requestRows: [],
          transitionRows: [],
          defaultBindingRow: null,
          auditCaveats: [],
          collectedAt: '2026-07-19T12:00:00Z',
        },
      };
    });

    mockGenerateEvaluationNarrative.mockResolvedValueOnce({
      text: 'This is the narrative commentary.',
      metadata: { provider: 'openai', model: 'gpt-4', tokensUsed: 0 },
    });

    const { store, written } = makeStore();

    await runEvaluation({
      db: {} as never,
      runId: 'run-test-preset-narrative',
      agentId: 'agent-test-preset-narrative',
      resolvedScope: { type: 'allTime' },
      includeNarrative: true,
      narrativeLlm: { provider: 'openai', model: 'gpt-4' },
      thresholds,
      store,
      storageRoot: '/tmp/eval-artifacts',
      attemptNumber: 1,
      maxAttempts: 1,
    });

    const report = written.get('REPORT.md');
    expect(report).toBeDefined();
    const appendixIndex = report!.indexOf('## Preset Assessment Summary');
    const commentaryIndex = report!.indexOf('## Commentary');
    expect(appendixIndex).toBeGreaterThan(-1);
    expect(commentaryIndex).toBeGreaterThan(-1);
    expect(appendixIndex).toBeLessThan(commentaryIndex);
  });
});

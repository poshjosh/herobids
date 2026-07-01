import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvaluationArtifactStore } from '@herobids/domain';
import type { ResolvedNarrativeLlmConfig } from '@herobids/db';

const mockCallLlmWithRetry = vi.fn();
vi.mock('../runtime-errors.js', () => ({
  callLlmWithRetry: mockCallLlmWithRetry,
}));

vi.mock('@herobids/llm', () => ({
  stripReasoningContent: (content: string) => content,
}));

const { generateEvaluationNarrative } = await import('./generate-narrative.js');

function mockNarrativeConfig(overrides: Partial<ResolvedNarrativeLlmConfig> = {}): ResolvedNarrativeLlmConfig {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    timeoutMs: 30_000,
    maxTokens: 1024,
    ...overrides,
  };
}

function mockArtifactStore(artifacts: Record<string, unknown> = {}): EvaluationArtifactStore {
  const encoder = new TextEncoder();
  const store = new Map<string, Uint8Array>();
  for (const [name, value] of Object.entries(artifacts)) {
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    store.set(name, encoder.encode(content));
  }
  return {
    write: async () => ({ name: '', mimeType: '', sizeBytes: 0 }),
    read: async (_runId: string, name: string) => store.get(name) ?? null,
    list: async () => [],
  };
}

function defaultArtifacts(): Record<string, unknown> {
  return {
    'agent-metadata.json': { executionMode: 'paper', dailyLossLimit: 500 },
    'sessions.json': [{ id: 's1', status: 'stopped', startedAt: '2026-07-01T08:00:00Z', stoppedAt: '2026-07-01T08:30:00Z' }],
    'fills.json': [],
    'positions.json': [],
    'costs.json': [],
    'journal.json': [
      { type: 'agent.tick.started', msg: 'Tick 1' },
      { type: 'agent.tick.skipped', msg: 'Outside trading hours' },
      { type: 'agent.tick.started', msg: 'Tick 2' },
      { type: 'agent.tick.skipped', msg: 'Outside trading hours' },
    ],
    'container-logs.txt': 'Agent runtime starting\nTick 1 skipped: outside_trading_hours\nTick 2 skipped: outside_trading_hours',
    'redis-snapshot.json': { 'agent:inbound:test': 'active', 'rate-limit:bybit': '5/10' },
  };
}

describe('generateEvaluationNarrative', () => {
  beforeEach(() => {
    mockCallLlmWithRetry.mockReset();
  });

  it('returns null text and error metadata when LLM call fails', async () => {
    mockCallLlmWithRetry.mockRejectedValueOnce(new Error('LLM timeout'));

    const result = await generateEvaluationNarrative(
      mockNarrativeConfig(),
      mockArtifactStore(defaultArtifacts()),
      'run-1',
    );

    expect(result.text).toBeNull();
    expect(result.metadata.generated).toBe(false);
    expect(result.metadata.provider).toBe('openai');
    expect(result.metadata.model).toBe('gpt-4o');
    expect(result.metadata.error).toContain('LLM timeout');
  });

  it('returns null text when LLM returns an error result', async () => {
    mockCallLlmWithRetry.mockResolvedValueOnce({
      result: { ok: false, error: { code: 'provider.timeout', message: 'Timed out' } },
    });

    const result = await generateEvaluationNarrative(
      mockNarrativeConfig(),
      mockArtifactStore(defaultArtifacts()),
      'run-1',
    );

    expect(result.text).toBeNull();
    expect(result.metadata.generated).toBe(false);
    expect(result.metadata.error).toContain('Timed out');
  });

  it('returns null text when LLM returns empty content', async () => {
    mockCallLlmWithRetry.mockResolvedValueOnce({
      result: {
        ok: true,
        data: {
          content: '   ',
          provider: 'openai',
          model: 'gpt-4o',
          tokensUsed: 0,
          latencyMs: 100,
        },
      },
    });

    const result = await generateEvaluationNarrative(
      mockNarrativeConfig(),
      mockArtifactStore(defaultArtifacts()),
      'run-1',
    );

    expect(result.text).toBeNull();
    expect(result.metadata.generated).toBe(false);
    expect(result.metadata.error).toContain('empty');
  });

  it('returns generated text and populated metadata on success', async () => {
    mockCallLlmWithRetry.mockResolvedValueOnce({
      result: {
        ok: true,
        data: {
          content: 'The agent session was healthy but all ticks were skipped due to trading hours restrictions. No trades were executed.',
          provider: 'openai',
          model: 'gpt-4o',
          tokensUsed: 250,
          inputTokens: 200,
          outputTokens: 50,
          latencyMs: 1200,
        },
      },
    });

    const result = await generateEvaluationNarrative(
      mockNarrativeConfig(),
      mockArtifactStore(defaultArtifacts()),
      'run-1',
    );

    expect(result.text).toBe('The agent session was healthy but all ticks were skipped due to trading hours restrictions. No trades were executed.');
    expect(result.metadata.generated).toBe(true);
    expect(result.metadata.provider).toBe('openai');
    expect(result.metadata.model).toBe('gpt-4o');
    expect(result.metadata.tokensUsed).toBe(250);
    expect(result.metadata.inputTokens).toBe(200);
    expect(result.metadata.outputTokens).toBe(50);
    expect(result.metadata.latencyMs).toBe(1200);
    expect(result.metadata.enabled).toBe(true);
  });

  it('includes raw evidence in the LLM prompt, not scorecard', async () => {
    const capturedRequests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    mockCallLlmWithRetry.mockImplementation(async (_config: unknown, request: { messages: Array<{ role: string; content: string }> }) => {
      capturedRequests.push(request);
      return {
        result: {
          ok: true,
          data: {
            content: 'Good session overall.',
            provider: 'openai',
            model: 'gpt-4o',
            tokensUsed: 100,
            latencyMs: 500,
          },
        },
      };
    });

    await generateEvaluationNarrative(
      mockNarrativeConfig(),
      mockArtifactStore(defaultArtifacts()),
      'run-1',
    );

    expect(capturedRequests.length).toBe(1);
    const promptContent = capturedRequests[0]!.messages[0]!.content;
    // Should contain evidence, NOT scorecard
    expect(promptContent).toContain('Agent Metadata');
    expect(promptContent).toContain('Trading Activity');
    expect(promptContent).toContain('Journal Summary');
    expect(promptContent).toContain('Container Logs');
    expect(promptContent).toContain('Redis Snapshot');
    // Should contain the journal data
    expect(promptContent).toContain('agent.tick.skipped');
    // Should NOT contain old scorecard fields
    expect(promptContent).not.toContain('Overall Score');
    expect(promptContent).not.toContain('Section Scores');
    expect(promptContent).not.toContain('Deterministic Report');
  });

  it('includes baseUrlUsed in metadata when configured', async () => {
    mockCallLlmWithRetry.mockResolvedValueOnce({
      result: {
        ok: true,
        data: {
          content: 'Commentary.',
          provider: 'openai',
          model: 'gpt-4o',
          tokensUsed: 50,
          latencyMs: 200,
        },
      },
    });

    const result = await generateEvaluationNarrative(
      mockNarrativeConfig({ baseUrl: 'https://custom.openai.com/v1' }),
      mockArtifactStore(defaultArtifacts()),
      'run-1',
    );

    expect(result.metadata.baseUrlUsed).toBe('https://custom.openai.com/v1');
  });

  it('always returns metadata even on unexpected errors', async () => {
    mockCallLlmWithRetry.mockRejectedValueOnce('unexpected crash');

    const result = await generateEvaluationNarrative(
      mockNarrativeConfig(),
      mockArtifactStore(defaultArtifacts()),
      'run-1',
    );

    expect(result.text).toBeNull();
    expect(result.metadata).toBeDefined();
    expect(result.metadata.provider).toBe('openai');
    expect(result.metadata.model).toBe('gpt-4o');
    expect(result.metadata.generated).toBe(false);
    expect(result.metadata.tokensUsed).toBe(0);
  });

  it('handles empty journal gracefully', async () => {
    mockCallLlmWithRetry.mockResolvedValueOnce({
      result: {
        ok: true,
        data: {
          content: 'No activity detected.',
          provider: 'openai',
          model: 'gpt-4o',
          tokensUsed: 30,
          latencyMs: 150,
        },
      },
    });

    const emptyArtifacts = { ...defaultArtifacts(), 'journal.json': [] };

    const result = await generateEvaluationNarrative(
      mockNarrativeConfig(),
      mockArtifactStore(emptyArtifacts),
      'run-1',
    );

    expect(result.text).toBe('No activity detected.');
    expect(result.metadata.generated).toBe(true);
  });

  it('handles missing artifacts gracefully', async () => {
    mockCallLlmWithRetry.mockResolvedValueOnce({
      result: {
        ok: true,
        data: {
          content: 'Insufficient data for commentary.',
          provider: 'openai',
          model: 'gpt-4o',
          tokensUsed: 20,
          latencyMs: 100,
        },
      },
    });

    // Only provide agent-metadata, nothing else
    const minimalArtifacts = {
      'agent-metadata.json': { executionMode: 'paper' },
    };

    const result = await generateEvaluationNarrative(
      mockNarrativeConfig(),
      mockArtifactStore(minimalArtifacts),
      'run-1',
    );

    expect(result.text).toBe('Insufficient data for commentary.');
    expect(result.metadata.generated).toBe(true);
  });

  it('returns error when artifact store throws', async () => {
    const brokenStore: EvaluationArtifactStore = {
      write: async () => ({ name: '', mimeType: '', sizeBytes: 0 }),
      read: async () => { throw new Error('Disk full'); },
      list: async () => [],
    };

    const result = await generateEvaluationNarrative(
      mockNarrativeConfig(),
      brokenStore,
      'run-1',
    );

    expect(result.text).toBeNull();
    expect(result.metadata.generated).toBe(false);
    expect(result.metadata.error).toContain('Disk full');
  });
});

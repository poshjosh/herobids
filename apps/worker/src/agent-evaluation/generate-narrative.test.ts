import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvaluationScorecard, EvaluationFinding } from '@herobids/domain';
import type { ResolvedNarrativeLlmConfig } from '@herobids/db';

// The function under test uses callLlmWithRetry which depends on the LLM
// provider module. We mock at the module boundary to avoid real LLM calls.
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

function mockScorecard(overrides: Partial<EvaluationScorecard> = {}): EvaluationScorecard {
  return {
    overallScore: 75,
    sections: [
      {
        section: 'session_health',
        score: 80,
        applicable: true,
        findings: [
          {
            section: 'session_health',
            severity: 'medium',
            code: 'session.short_duration',
            title: 'Short session duration',
            detail: 'Session lasted only 2 minutes.',
          },
        ],
      },
      {
        section: 'trading_performance',
        score: 60,
        applicable: true,
        findings: [
          {
            section: 'trading_performance',
            severity: 'high',
            code: 'trading.high_drawdown',
            title: 'High drawdown detected',
            detail: 'Drawdown exceeded 15% threshold.',
          },
        ],
      },
      {
        section: 'cost',
        score: 90,
        applicable: true,
        findings: [],
      },
    ],
    ...overrides,
  };
}

function mockFindings(): EvaluationFinding[] {
  return [
    {
      section: 'trading_performance',
      severity: 'high',
      code: 'trading.high_drawdown',
      title: 'High drawdown detected',
      detail: 'Drawdown exceeded 15% threshold.',
    },
    {
      section: 'session_health',
      severity: 'medium',
      code: 'session.short_duration',
      title: 'Short session duration',
      detail: 'Session lasted only 2 minutes.',
    },
  ];
}

describe('generateEvaluationNarrative', () => {
  beforeEach(() => {
    mockCallLlmWithRetry.mockReset();
  });

  it('returns null text and error metadata when LLM call fails', async () => {
    mockCallLlmWithRetry.mockRejectedValueOnce(new Error('LLM timeout'));

    const result = await generateEvaluationNarrative(
      mockNarrativeConfig(),
      mockScorecard(),
      mockFindings(),
      '# Report\n\nDeterministic report content.',
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
      mockScorecard(),
      mockFindings(),
      '# Report',
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
      mockScorecard(),
      mockFindings(),
      '# Report',
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
          content: 'The agent showed strong cost efficiency but had elevated drawdown risk.',
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
      mockScorecard(),
      mockFindings(),
      '# Report\n\nSome report text.',
    );

    expect(result.text).toBe('The agent showed strong cost efficiency but had elevated drawdown risk.');
    expect(result.metadata.generated).toBe(true);
    expect(result.metadata.provider).toBe('openai');
    expect(result.metadata.model).toBe('gpt-4o');
    expect(result.metadata.tokensUsed).toBe(250);
    expect(result.metadata.inputTokens).toBe(200);
    expect(result.metadata.outputTokens).toBe(50);
    expect(result.metadata.latencyMs).toBe(1200);
    expect(result.metadata.enabled).toBe(true);
  });

  it('includes the redacted report text in the LLM prompt', async () => {
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
      mockScorecard(),
      mockFindings(),
      '# Evaluation Report\n\n## Section: Trading\n\nDrawdown was elevated.',
    );

    expect(capturedRequests.length).toBe(1);
    const promptContent = capturedRequests[0]!.messages[0]!.content;
    expect(promptContent).toContain('Overall Score: 75');
    expect(promptContent).toContain('session health: 80/100');
    expect(promptContent).toContain('trading performance: 60/100');
    expect(promptContent).toContain('[HIGH] trading.high_drawdown');
    expect(promptContent).toContain('Deterministic Report:');
    expect(promptContent).toContain('# Evaluation Report');
    expect(promptContent).toContain('Drawdown was elevated');
  });

  it('truncates long report text to avoid token bloat', async () => {
    const capturedRequests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    mockCallLlmWithRetry.mockImplementation(async (_config: unknown, request: { messages: Array<{ role: string; content: string }> }) => {
      capturedRequests.push(request);
      return {
        result: {
          ok: true,
          data: {
            content: 'Ok.',
            provider: 'openai',
            model: 'gpt-4o',
            tokensUsed: 50,
            latencyMs: 300,
          },
        },
      };
    });

    const longReport = 'x'.repeat(10_000);

    await generateEvaluationNarrative(
      mockNarrativeConfig(),
      mockScorecard(),
      mockFindings(),
      longReport,
    );

    const promptContent = capturedRequests[0]!.messages[0]!.content;
    expect(promptContent).toContain('truncated for length');
    expect(promptContent.length).toBeLessThan(longReport.length + 500);
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
      mockScorecard(),
      mockFindings(),
      '# Report',
    );

    expect(result.metadata.baseUrlUsed).toBe('https://custom.openai.com/v1');
  });

  it('always returns metadata even on unexpected errors', async () => {
    mockCallLlmWithRetry.mockRejectedValueOnce('unexpected crash');

    const result = await generateEvaluationNarrative(
      mockNarrativeConfig(),
      mockScorecard(),
      mockFindings(),
      '# Report',
    );

    expect(result.text).toBeNull();
    expect(result.metadata).toBeDefined();
    expect(result.metadata.provider).toBe('openai');
    expect(result.metadata.model).toBe('gpt-4o');
    expect(result.metadata.generated).toBe(false);
    expect(result.metadata.tokensUsed).toBe(0);
  });

  it('handles findings list with no findings gracefully', async () => {
    mockCallLlmWithRetry.mockResolvedValueOnce({
      result: {
        ok: true,
        data: {
          content: 'All clear.',
          provider: 'openai',
          model: 'gpt-4o',
          tokensUsed: 30,
          latencyMs: 150,
        },
      },
    });

    const result = await generateEvaluationNarrative(
      mockNarrativeConfig(),
      mockScorecard({ sections: [], overallScore: 100 }),
      [],
      '# Report',
    );

    expect(result.text).toBe('All clear.');
    expect(result.metadata.generated).toBe(true);
  });
});

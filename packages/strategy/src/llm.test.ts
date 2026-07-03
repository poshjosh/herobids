import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlmStrategy, clearLlmResponseCache } from './llm.js';
import type { LlmDecisionArtifact } from './llm.js';
import type { MarketSnapshot } from '@herobids/domain';
import { price } from '@herobids/domain';

const baseSnapshot: MarketSnapshot = {
  symbol: 'BTC-USD',
  price: price('50000'),
  timestamp: '2025-01-01T00:00:00Z',
  data: { volume24h: 100_000 },
};

const baseConfig: Record<string, unknown> = {
  provider: 'openai',
  model: 'gpt-4',
  maxTokens: 1024,
  timeoutMs: 30_000,
  positionSize: '1',
};

function mockFetch(response: object, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(response),
    json: async () => response,
  });
}

describe('LlmStrategy', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearLlmResponseCache();
    vi.stubEnv('LLM_API_KEY_OPENAI', 'test-key-123');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearLlmResponseCache();
    vi.unstubAllEnvs();
  });

  it('returns a go_long decision on valid response', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: '{"intent": "go_long", "confidence": 0.9, "reasoning": "Bullish momentum"}' } }],
      usage: { total_tokens: 150 },
      model: 'gpt-4',
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'test-decision-id');
    const result = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).not.toBeNull();
      expect(result.data!.intent).toBe('go_long');
      expect(result.data!.metadata?.confidence).toBe(0.9);
      expect(result.data!.metadata?.reasoning).toBe('Bullish momentum');
    }
  });

  it('returns null for hold intent', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: '{"intent": "hold", "confidence": 0.3, "reasoning": "No clear signal"}' } }],
      usage: { total_tokens: 80 },
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'test-decision-id');
    const result = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it('returns error for invalid intent', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: '{"intent": "buy_everything", "confidence": 1}' } }],
      usage: { total_tokens: 50 },
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'test-decision-id');
    const result = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('strategy.llm_parse_error');
    }
  });

  it('handles JSON wrapped in markdown code blocks', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: '```json\n{"intent": "go_short", "confidence": 0.7}\n```' } }],
      usage: { total_tokens: 100 },
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'test-decision-id');
    const result = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data!.intent).toBe('go_short');
    }
  });

  it('returns error on malformed JSON response', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: 'I think you should buy BTC because it is great.' } }],
      usage: { total_tokens: 60 },
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'test-decision-id');
    const result = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('strategy.llm_parse_error');
      expect(result.error.message).toContain('No JSON object found');
    }
  });

  it('returns error when API key is missing', async () => {
    vi.unstubAllEnvs();
    delete process.env['LLM_API_KEY_OPENAI'];
    delete process.env['LLM_API_KEY'];

    const strategy = new LlmStrategy(() => 'test-decision-id');
    const result = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('strategy.llm_provider_error');
      expect(result.error.message).toContain('No API key');
    }
  });

  it('returns error on HTTP 500', async () => {
    globalThis.fetch = mockFetch({ error: 'Internal Server Error' }, 500) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'test-decision-id');
    const result = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('strategy.llm_provider_error');
    }
  });

  it('emits artifact on successful call', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: '{"intent": "go_flat", "confidence": 0.95, "reasoning": "Exit now"}' } }],
      usage: { total_tokens: 120 },
      model: 'gpt-4',
    }) as unknown as typeof fetch;

    const artifacts: LlmDecisionArtifact[] = [];
    const strategy = new LlmStrategy(() => 'artifact-dec-id', async (a) => { artifacts.push(a); });
    await strategy.evaluate(baseSnapshot, baseConfig);

    expect(artifacts).toHaveLength(1);
    const a = artifacts[0]!;
    expect(a.decisionId).toBe('artifact-dec-id');
    expect(a.parseStatus).toBe('success');
    expect(a.parsedDecision?.intent).toBe('go_flat');
    expect(a.provider).toBe('openai');
    expect(a.model).toBe('gpt-4');
    expect(a.contextHash).toHaveLength(16);
  });

  it('emits artifact on provider error', async () => {
    vi.unstubAllEnvs();
    delete process.env['LLM_API_KEY_OPENAI'];
    delete process.env['LLM_API_KEY'];

    const artifacts: LlmDecisionArtifact[] = [];
    const strategy = new LlmStrategy(() => 'error-dec-id', async (a) => { artifacts.push(a); });
    await strategy.evaluate(baseSnapshot, baseConfig);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.parseStatus).toBe('provider_error');
    expect(artifacts[0]!.rawResponse).toBeNull();
  });

  it('emits artifact on parse error', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: 'not json at all' } }],
      usage: { total_tokens: 30 },
    }) as unknown as typeof fetch;

    const artifacts: LlmDecisionArtifact[] = [];
    const strategy = new LlmStrategy(() => 'parse-err-id', async (a) => { artifacts.push(a); });
    await strategy.evaluate(baseSnapshot, baseConfig);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.parseStatus).toBe('parse_error');
    expect(artifacts[0]!.rawResponse).toBe('not json at all');
  });

  it('produces deterministic contextHash for same inputs', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: '{"intent": "hold"}' } }],
      usage: { total_tokens: 10 },
    }) as unknown as typeof fetch;

    const hashes: string[] = [];
    const strategy = new LlmStrategy(() => 'hash-test', async (a) => { hashes.push(a.contextHash); });

    await strategy.evaluate(baseSnapshot, baseConfig);
    await strategy.evaluate(baseSnapshot, baseConfig);

    expect(hashes[0]).toBe(hashes[1]);
  });

  it('produces different contextHash for different prices', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: '{"intent": "hold"}' } }],
      usage: { total_tokens: 10 },
    }) as unknown as typeof fetch;

    const hashes: string[] = [];
    const strategy = new LlmStrategy(() => 'hash-diff', async (a) => { hashes.push(a.contextHash); });

    await strategy.evaluate(baseSnapshot, baseConfig);
    await strategy.evaluate({ ...baseSnapshot, price: price('60000') }, baseConfig);

    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('builds prompt with correct snapshot data', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"intent": "hold"}' } }],
          usage: { total_tokens: 10 },
        }),
      };
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'prompt-test');
    await strategy.evaluate(baseSnapshot, baseConfig);

    expect(capturedBody).toBeDefined();
    const body = JSON.parse(capturedBody!);
    const userMessage = body.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMessage.content).toContain('BTC-USD');
    expect(userMessage.content).toContain('50000');
    expect(userMessage.content).toContain('2025-01-01T00:00:00Z');
  });

  it('returns go_flat decision correctly', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: '{"intent": "go_flat", "confidence": 0.85, "reasoning": "Exit signal detected"}' } }],
      usage: { total_tokens: 90 },
      model: 'gpt-4',
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'flat-dec-id');
    const result = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).not.toBeNull();
      expect(result.data!.intent).toBe('go_flat');
      expect(result.data!.metadata?.reasoning).toBe('Exit signal detected');
    }
  });

  it('returns go_short decision correctly', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: '{"intent": "go_short", "confidence": 0.6}' } }],
      usage: { total_tokens: 70 },
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'short-dec-id');
    const result = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data!.intent).toBe('go_short');
      expect(result.data!.metadata?.confidence).toBe(0.6);
      expect(result.data!.metadata?.reasoning).toBeUndefined();
    }
  });

  it('does not throw when onArtifact callback throws', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: '{"intent": "hold"}' } }],
      usage: { total_tokens: 10 },
    }) as unknown as typeof fetch;

    const failingCallback = async () => { throw new Error('DB connection lost'); };
    const strategy = new LlmStrategy(() => 'robust-id', failingCallback);

    // Should not throw even though the artifact callback throws
    const result = await strategy.evaluate(baseSnapshot, baseConfig);
    expect(result.ok).toBe(true);
  });

  it('uses custom instrumentId from config', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: '{"intent": "go_long", "confidence": 0.9}' } }],
      usage: { total_tokens: 50 },
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'instrument-test');
    const result = await strategy.evaluate(baseSnapshot, { ...baseConfig, instrumentId: 'ETH/USD:USD' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data!.instrumentId).toBe('ETH/USD:USD');
    }
  });

  it('uses snapshot symbol as instrumentId when config has none', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: '{"intent": "go_long", "confidence": 0.7}' } }],
      usage: { total_tokens: 50 },
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'sym-test');
    const result = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data!.instrumentId).toBe('BTC-USD');
    }
  });

  it('uses custom positionSize from config', async () => {
    globalThis.fetch = mockFetch({
      choices: [{ message: { content: '{"intent": "go_long", "confidence": 0.9}' } }],
      usage: { total_tokens: 50 },
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'size-test');
    const result = await strategy.evaluate(baseSnapshot, { ...baseConfig, positionSize: '2.5' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data!.targetSize.toString()).toBe('2.5');
    }
  });

  it('reuses cached provider output for identical replay contexts', async () => {
    const fetchMock = mockFetch({
      choices: [{ message: { content: '{"intent": "go_long", "confidence": 0.9}' } }],
      usage: { total_tokens: 150 },
      model: 'gpt-4',
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const artifacts: LlmDecisionArtifact[] = [];
    const strategy = new LlmStrategy(() => 'cache-test-id', async (artifact) => {
      artifacts.push(artifact);
    });

    const first = await strategy.evaluate(baseSnapshot, baseConfig);
    const second = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]!.cached).toBe(false);
    expect(artifacts[1]!.cached).toBe(true);
  });

  it('truncates reasoning longer than 80 chars to exactly 80 chars', async () => {
    const reasoning120 = 'B'.repeat(120);
    const content = JSON.stringify({ intent: 'go_long', confidence: 0.85, reasoning: reasoning120 });
    globalThis.fetch = mockFetch({
      choices: [{ message: { content } }],
      usage: { total_tokens: 50 },
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'truncate-test-id');
    const result = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data!.metadata?.reasoning).toHaveLength(80);
      expect(result.data!.metadata?.reasoning).toBe(reasoning120.slice(0, 80));
    }
  });

  it('passes through reasoning of exactly 80 chars unchanged', async () => {
    const reasoning80 = 'B'.repeat(80);
    const content = JSON.stringify({ intent: 'go_long', confidence: 0.85, reasoning: reasoning80 });
    globalThis.fetch = mockFetch({
      choices: [{ message: { content } }],
      usage: { total_tokens: 50 },
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'exact-80-test-id');
    const result = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data!.metadata?.reasoning).toBe(reasoning80);
      expect(result.data!.metadata?.reasoning).toHaveLength(80);
    }
  });

  it('treats empty string reasoning as undefined', async () => {
    const content = JSON.stringify({ intent: 'go_long', confidence: 0.85, reasoning: '' });
    globalThis.fetch = mockFetch({
      choices: [{ message: { content } }],
      usage: { total_tokens: 50 },
    }) as unknown as typeof fetch;

    const strategy = new LlmStrategy(() => 'empty-reasoning-test-id');
    const result = await strategy.evaluate(baseSnapshot, baseConfig);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data!.metadata?.reasoning).toBeUndefined();
    }
  });
});

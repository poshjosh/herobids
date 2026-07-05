import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchOpenRouterPricing } from './openrouter-pricing.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFetchResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('fetchOpenRouterPricing', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a well-formed response and converts per-token USD to per-1M USD', async () => {
    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: [
          {
            id: 'openai/gpt-4o',
            pricing: {
              prompt: '0.0000025',    // $2.5 per 1M
              completion: '0.00001',  // $10 per 1M
            },
          },
          {
            id: 'anthropic/claude-sonnet-4-5',
            pricing: {
              prompt: '0.000003',    // $3 per 1M
              completion: '0.000015', // $15 per 1M
            },
          },
        ],
      }),
    );

    const result = await fetchOpenRouterPricing({
      apiKey: 'test-key',
      fetchUrl: 'https://openrouter.ai/api/v1',
      timeoutMs: 5_000,
    });

    expect(result.models['openai/gpt-4o']).toEqual({
      inputUsdPerM: 2.5,
      outputUsdPerM: 10,
    });
    expect(result.models['anthropic/claude-sonnet-4-5']).toEqual({
      inputUsdPerM: 3,
      outputUsdPerM: 15,
    });
  });

  it('returns empty models object on non-OK HTTP response', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse({}, false, 429));

    const result = await fetchOpenRouterPricing({
      apiKey: 'test-key',
      fetchUrl: 'https://openrouter.ai/api/v1',
      timeoutMs: 5_000,
    });

    expect(result.models).toEqual({});
  });

  it('returns empty models object on network failure', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'));

    const result = await fetchOpenRouterPricing({
      apiKey: 'test-key',
      fetchUrl: 'https://openrouter.ai/api/v1',
      timeoutMs: 5_000,
    });

    expect(result.models).toEqual({});
  });

  it('skips models whose pricing fields cannot be parsed as finite numbers', async () => {
    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: [
          {
            id: 'valid/model',
            pricing: { prompt: '0.000001', completion: '0.000002' },
          },
          {
            id: 'invalid-prompt/model',
            pricing: { prompt: 'not-a-number', completion: '0.000002' },
          },
          {
            id: 'no-pricing/model',
            // no pricing field at all
          },
          {
            id: 'negative/model',
            pricing: { prompt: '-0.000001', completion: '0.000002' },
          },
        ],
      }),
    );

    const result = await fetchOpenRouterPricing({
      apiKey: 'test-key',
      fetchUrl: 'https://openrouter.ai/api/v1',
      timeoutMs: 5_000,
    });

    expect(result.models['valid/model']).toBeDefined();
    expect(result.models['invalid-prompt/model']).toBeUndefined();
    expect(result.models['no-pricing/model']).toBeUndefined();
    expect(result.models['negative/model']).toBeUndefined();
  });

  it('includes models with zero pricing (free tier)', async () => {
    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: [
          {
            id: 'meta-llama/llama-3-8b-free',
            pricing: { prompt: '0', completion: '0' },
          },
        ],
      }),
    );

    const result = await fetchOpenRouterPricing({
      apiKey: 'test-key',
      fetchUrl: 'https://openrouter.ai/api/v1',
      timeoutMs: 5_000,
    });

    expect(result.models['meta-llama/llama-3-8b-free']).toEqual({
      inputUsdPerM: 0,
      outputUsdPerM: 0,
    });
  });

  it('handles a missing data array gracefully', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse({}));

    const result = await fetchOpenRouterPricing({
      apiKey: 'test-key',
      fetchUrl: 'https://openrouter.ai/api/v1',
      timeoutMs: 5_000,
    });

    expect(result.models).toEqual({});
  });

  it('sends Authorization header with the provided API key', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse({ data: [] }));

    await fetchOpenRouterPricing({
      apiKey: 'sk-or-test-key',
      fetchUrl: 'https://openrouter.ai/api/v1',
      timeoutMs: 5_000,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)?.['Authorization']).toBe('Bearer sk-or-test-key');
  });

  it('returns empty models when fetchUrl is not a valid URL', async () => {
    const result = await fetchOpenRouterPricing({
      apiKey: 'test-key',
      fetchUrl: 'not-a-valid-url',
      timeoutMs: 5_000,
    });

    expect(result.models).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('includes cacheReadUsdPerM when cache_read pricing is present', async () => {
    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        data: [
          {
            id: 'anthropic/claude-sonnet-4-5',
            pricing: {
              prompt: '0.000003',    // $3/M
              completion: '0.000015', // $15/M
              cache_read: '0.0000003', // $0.3/M (10% of input)
            },
          },
          {
            id: 'openai/gpt-4o',
            pricing: {
              prompt: '0.0000025', // $2.5/M
              completion: '0.00001', // $10/M
              // no cache_read field
            },
          },
        ],
      }),
    );

    const result = await fetchOpenRouterPricing({
      apiKey: 'test-key',
      fetchUrl: 'https://openrouter.ai/api/v1',
      timeoutMs: 5_000,
    });

    expect(result.models['anthropic/claude-sonnet-4-5']).toMatchObject({
      inputUsdPerM: 3,
      outputUsdPerM: 15,
      cacheReadUsdPerM: 0.3,
    });
    // model without cache_read should not have the field at all
    expect(result.models['openai/gpt-4o']).not.toHaveProperty('cacheReadUsdPerM');
  });
});

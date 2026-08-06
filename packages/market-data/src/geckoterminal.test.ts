import { describe, expect, it } from 'vitest';
import { fetchGeckoTerminalTrendingPools, fetchGeckoTerminalTopPools, fetchGeckoTerminalCandles, fetchGeckoTerminalNewPools, validateApiKey } from './geckoterminal.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

function makePoolResponse() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      data: [{
        id: 'pool-1',
        attributes: { address: 'pool-1', base_token_price_usd: '1.0', volume_usd: { h24: '10000' }, reserve_in_usd: '20000' },
        relationships: { base_token: { data: { id: 'bt-1' } }, quote_token: { data: { id: 'qt-1' } } },
      }],
      included: [
        { id: 'bt-1', attributes: { address: 'token-1', symbol: 'TK1', name: 'Token1' } },
        { id: 'qt-1', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
      ],
    }),
  } as Response;
}

describe('fetchGeckoTerminalTrendingPools', () => {
  it('appends ?page=2 to the URL and uses trending_pools_p2 as the discovery vector', async () => {
    let capturedUrl = '';
    const config = {
      baseUrl: 'https://api.geckoterminal.com',
      timeoutMs: 5_000,
      rateLimiter: new TokenBucketRateLimiter({ requestsPerMinute: 1_000 }),
      fetchFn: async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        capturedUrl = String(input);
        return makePoolResponse();
      },
    };

    const result = await fetchGeckoTerminalTrendingPools('solana', config, 2);

    expect(capturedUrl).toBe('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=2');
    expect(result[0]?.discoveryVectors).toEqual(['trending_pools_p2']);
  });
});

describe('Pro on-chain tier (apiKey)', () => {
  it('uses pro-api.coingecko.com URL and x-cg-pro-api-key header when apiKey is configured', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const config = {
      baseUrl: 'https://api.geckoterminal.com',
      apiKey: 'test-api-key',
      timeoutMs: 5_000,
      rateLimiter: new TokenBucketRateLimiter({ requestsPerMinute: 1_000 }),
      fetchFn: async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
        capturedUrl = String(input);
        if (init?.headers) {
          capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
        }
        return makePoolResponse();
      },
    };

    await fetchGeckoTerminalTrendingPools('solana', config, 1);

    expect(capturedUrl).toBe('https://pro-api.coingecko.com/api/v3/onchain/networks/solana/trending_pools');
    expect(capturedHeaders['x-cg-pro-api-key']).toBe('test-api-key');
  });

  it('uses free public endpoint when apiKey is empty string', async () => {
    let capturedUrl = '';
    const config = {
      baseUrl: 'https://api.geckoterminal.com',
      apiKey: '',
      timeoutMs: 5_000,
      rateLimiter: new TokenBucketRateLimiter({ requestsPerMinute: 1_000 }),
      fetchFn: async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        capturedUrl = String(input);
        return makePoolResponse();
      },
    };

    await fetchGeckoTerminalTrendingPools('solana', config, 1);

    expect(capturedUrl).toBe('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools');
  });

  it('uses pro URL and header for newPools endpoint', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const config = {
      baseUrl: 'https://api.geckoterminal.com',
      apiKey: 'test-api-key',
      timeoutMs: 5_000,
      rateLimiter: new TokenBucketRateLimiter({ requestsPerMinute: 1_000 }),
      fetchFn: async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
        capturedUrl = String(input);
        if (init?.headers) {
          capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
        }
        return makePoolResponse();
      },
    };

    await fetchGeckoTerminalNewPools('solana', config);

    expect(capturedUrl).toBe('https://pro-api.coingecko.com/api/v3/onchain/networks/solana/new_pools');
    expect(capturedHeaders['x-cg-pro-api-key']).toBe('test-api-key');
  });

  it('uses free public endpoint unchanged when apiKey is absent', async () => {
    let capturedUrl = '';
    const config = {
      baseUrl: 'https://api.geckoterminal.com',
      timeoutMs: 5_000,
      rateLimiter: new TokenBucketRateLimiter({ requestsPerMinute: 1_000 }),
      fetchFn: async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        capturedUrl = String(input);
        return makePoolResponse();
      },
    };

    await fetchGeckoTerminalTrendingPools('solana', config, 1);

    expect(capturedUrl).toBe('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools');
  });

  it('uses pro URL and header for candles endpoint', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const config = {
      baseUrl: 'https://api.geckoterminal.com',
      apiKey: 'test-api-key',
      timeoutMs: 5_000,
      rateLimiter: new TokenBucketRateLimiter({ requestsPerMinute: 1_000 }),
      fetchFn: async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
        capturedUrl = String(input);
        if (init?.headers) {
          capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
        } as Response;
      },
    };

    await fetchGeckoTerminalCandles('solana', 'pool-1', config, { timeframe: 'hour', limit: 10 });

    expect(capturedUrl).toBe('https://pro-api.coingecko.com/api/v3/onchain/networks/solana/pools/pool-1/ohlcv/hour?limit=10');
    expect(capturedHeaders['x-cg-pro-api-key']).toBe('test-api-key');
  });
});

describe('fetchGeckoTerminalTopPools', () => {
  it('appends &page=2 to the URL and uses top_pools_p2 as the discovery vector', async () => {
    let capturedUrl = '';
    const config = {
      baseUrl: 'https://api.geckoterminal.com',
      timeoutMs: 5_000,
      rateLimiter: new TokenBucketRateLimiter({ requestsPerMinute: 1_000 }),
      fetchFn: async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        capturedUrl = String(input);
        return makePoolResponse();
      },
    };

    const result = await fetchGeckoTerminalTopPools('solana', config, 2);

    expect(capturedUrl).toBe('https://api.geckoterminal.com/api/v2/networks/solana/pools?sort=h24_volume_usd_desc&page=2');
    expect(result[0]?.discoveryVectors).toEqual(['top_pools_p2']);
  });
});

describe('validateApiKey', () => {
  it('resolves when the Pro endpoint returns 200', async () => {
    const call = validateApiKey({
      apiKey: 'valid-key',
      timeoutMs: 5_000,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '{}',
      } as Response),
    });

    await expect(call).resolves.toBeUndefined();
  });

  it('throws when the Pro endpoint returns 401', async () => {
    const call = validateApiKey({
      apiKey: 'invalid-key',
      timeoutMs: 5_000,
      fetchFn: async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Unauthorized',
      } as Response),
    });

    await expect(call).rejects.toThrow('GeckoTerminal Pro API key is invalid or the endpoint is unreachable (HTTP 401)');
  });

  it('throws when the Pro endpoint returns 403', async () => {
    const call = validateApiKey({
      apiKey: 'forbidden-key',
      timeoutMs: 5_000,
      fetchFn: async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'Forbidden',
      } as Response),
    });

    await expect(call).rejects.toThrow('GeckoTerminal Pro API key is invalid or the endpoint is unreachable (HTTP 403)');
  });

  it('uses the provided proBaseUrl when specified', async () => {
    let capturedUrl = '';
    await validateApiKey({
      apiKey: 'test-key',
      proBaseUrl: 'https://custom-proxy.example.com',
      timeoutMs: 5_000,
      fetchFn: async (input) => {
        capturedUrl = String(input);
        return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' } as Response;
      },
    });

    expect(capturedUrl).toBe('https://custom-proxy.example.com/api/v3/onchain/networks/solana/trending_pools');
  });

  it('uses default pro-api.coingecko.com when proBaseUrl is not provided', async () => {
    let capturedUrl = '';
    await validateApiKey({
      apiKey: 'test-key',
      timeoutMs: 5_000,
      fetchFn: async (input) => {
        capturedUrl = String(input);
        return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' } as Response;
      },
    });

    expect(capturedUrl).toBe('https://pro-api.coingecko.com/api/v3/onchain/networks/solana/trending_pools');
  });
});

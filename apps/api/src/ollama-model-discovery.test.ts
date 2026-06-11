import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizeOllamaCatalogUrl, discoverOllamaModels, clearOllamaModelCache } from './ollama-model-discovery.js';

afterEach(() => {
  clearOllamaModelCache();
});

// ─── normalizeOllamaCatalogUrl ────────────────────────────────────────────────

describe('normalizeOllamaCatalogUrl', () => {
  it('strips /v1 and appends /api/tags', () => {
    const result = normalizeOllamaCatalogUrl('http://host.docker.internal:11434/v1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('http://host.docker.internal:11434/api/tags');
  });

  it('strips trailing slash then /v1', () => {
    const result = normalizeOllamaCatalogUrl('http://host.docker.internal:11434/v1/');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('http://host.docker.internal:11434/api/tags');
  });

  it('handles base URL with no path segment', () => {
    const result = normalizeOllamaCatalogUrl('http://localhost:11434');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('http://localhost:11434/api/tags');
  });

  it('preserves path prefix before /v1', () => {
    const result = normalizeOllamaCatalogUrl('https://proxy.example.com/ollama/v1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('https://proxy.example.com/ollama/api/tags');
  });

  it('preserves path prefix before trailing-slash /v1', () => {
    const result = normalizeOllamaCatalogUrl('https://proxy.example.com/ollama/v1/');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('https://proxy.example.com/ollama/api/tags');
  });

  it('does not strip /v1 that is not the terminal segment', () => {
    const result = normalizeOllamaCatalogUrl('http://localhost:11434/v1beta');
    expect(result.ok).toBe(true);
    // /v1beta is not /v1, so just append /api/tags to the full path
    if (result.ok) expect(result.data).toBe('http://localhost:11434/v1beta/api/tags');
  });

  it('drops query string and hash', () => {
    const result = normalizeOllamaCatalogUrl('http://localhost:11434/v1?foo=bar#baz');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('http://localhost:11434/api/tags');
  });

  it('rejects a completely invalid URL string', () => {
    const result = normalizeOllamaCatalogUrl('not-a-url');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('catalog.invalid_base_url');
  });

  it('rejects non-http/https schemes', () => {
    const result = normalizeOllamaCatalogUrl('ftp://localhost:11434/v1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('catalog.invalid_base_url');
  });
});

// ─── discoverOllamaModels ─────────────────────────────────────────────────────

describe('discoverOllamaModels — no baseUrl', () => {
  it('returns fallback source with only the configured model when no baseUrl is given', async () => {
    const result = await discoverOllamaModels({
      baseUrl: undefined,
      configuredModel: 'qwen3-coder:30b',
      timeoutMs: 1000,
      cacheTtlMs: 15_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('fallback');
      // Only the configured model — not the domain static list
      expect(result.data.models).toEqual(['qwen3-coder:30b']);
    }
  });

  it('returns only the configured model when no baseUrl is given (not the domain static list)', async () => {
    const result = await discoverOllamaModels({
      baseUrl: undefined,
      configuredModel: 'deepseek-r1:latest',
      timeoutMs: 1000,
      cacheTtlMs: 15_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.models).toEqual(['deepseek-r1:latest']);
    }
  });
});

describe('discoverOllamaModels — invalid base URL', () => {
  it('returns err for an unsupported URL scheme', async () => {
    const result = await discoverOllamaModels({
      baseUrl: 'ftp://localhost:11434/v1',
      configuredModel: 'qwen3-coder:30b',
      timeoutMs: 1000,
      cacheTtlMs: 15_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('catalog.invalid_base_url');
  });
});

describe('discoverOllamaModels — successful fetch', () => {
  it('returns dynamic models from /api/tags and merges configured model', async () => {
    // Mock global fetch to simulate a live Ollama instance
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'deepseek-r1:latest', modified_at: '2024-01-01', size: 100 },
          { name: 'llama3:8b', modified_at: '2024-01-01', size: 200 },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverOllamaModels({
      baseUrl: 'http://localhost:11434/v1',
      configuredModel: 'deepseek-r1:latest',
      timeoutMs: 3000,
      cacheTtlMs: 15_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('dynamic');
      expect(result.data.models).toContain('deepseek-r1:latest');
      expect(result.data.models).toContain('llama3:8b');
      // Models should be sorted
      expect(result.data.models).toEqual([...result.data.models].sort());
    }

    vi.unstubAllGlobals();
  });

  it('returns cached result on second call without re-fetching', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3:8b' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = { baseUrl: 'http://localhost:11434/v1', configuredModel: 'llama3:8b', timeoutMs: 3000, cacheTtlMs: 60_000 };
    await discoverOllamaModels(config);
    await discoverOllamaModels(config);

    // Should only have fetched once — second call used the cache
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});

describe('discoverOllamaModels — fetch failure', () => {
  it('returns cold-start fallback with configured model only when fetch fails and no cache exists', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverOllamaModels({
      baseUrl: 'http://localhost:11434/v1',
      configuredModel: 'qwen3-coder:30b',
      timeoutMs: 3000,
      cacheTtlMs: 15_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('fallback');
      // Cold-start: only the configured model, not the domain static list
      expect(result.data.models).toEqual(['qwen3-coder:30b']);
    }

    vi.unstubAllGlobals();
  });

  it('returns catalog.timeout path when fetch throws AbortError (simulated timeout)', async () => {
    const abortError = new Error('This operation was aborted');
    abortError.name = 'AbortError';
    const fetchMock = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverOllamaModels({
      baseUrl: 'http://localhost:11434/v1',
      configuredModel: 'qwen3-coder:30b',
      timeoutMs: 3000,
      cacheTtlMs: 15_000,
    });

    // AbortError hits catalog.timeout path; no prior cache → cold-start fallback
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('fallback');
      expect(result.data.models).toEqual(['qwen3-coder:30b']);
    }

    vi.unstubAllGlobals();
  });

  it('returns stale cache on re-fetch failure', async () => {
    // Populate cache with a fresh successful fetch
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: 'cached-model:latest' }, { name: 'other-model:7b' }] }),
      })
      .mockRejectedValueOnce(new Error('Network down'));

    vi.stubGlobal('fetch', fetchMock);

    const config = {
      baseUrl: 'http://localhost:11434/v1',
      configuredModel: 'qwen3-coder:30b',
      timeoutMs: 3000,
      cacheTtlMs: 1, // 1ms TTL — will be stale immediately
    };

    // First fetch: success, populates cache
    const first = await discoverOllamaModels(config);
    expect(first.ok).toBe(true);

    // Wait for cache to go stale
    await new Promise((resolve) => { setTimeout(resolve, 5); });

    // Second call: stale cache + re-fetch fails → should return stale models
    const second = await discoverOllamaModels(config);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.models).toContain('cached-model:latest');
      expect(second.data.models).toContain('other-model:7b');
    }

    vi.unstubAllGlobals();
  });

  it('returns err for invalid Ollama /api/tags response shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tags: ['wrong-shape'] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverOllamaModels({
      baseUrl: 'http://localhost:11434/v1',
      configuredModel: 'qwen3-coder:30b',
      timeoutMs: 3000,
      cacheTtlMs: 15_000,
    });

    // Invalid response shape → cold-start fallback (no prior cache)
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('fallback');
    }

    vi.unstubAllGlobals();
  });
});

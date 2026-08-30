import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { ExternalSkillProviderHttp } from './external-skill-provider-http.js';
import type { ExternalSkillProviderHttpConfig } from './external-skill-provider-http.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<ExternalSkillProviderHttpConfig>): ExternalSkillProviderHttpConfig {
  return {
    baseUrl: 'http://skills.local:3000',
    searchTimeoutMs: 5000,
    browseTimeoutMs: 5000,
    statsTimeoutMs: 3000,
    ...overrides,
  };
}

function makeLogger(): FastifyBaseLogger {
  return { warn: vi.fn() } as unknown as FastifyBaseLogger;
}

/** Builds a valid skills-api page response body. */
function makeSkillsPageBody(
  skills: Array<Record<string, unknown>> = [],
  opts: { total?: number; page?: number; pageSize?: number } = {},
) {
  return {
    skills,
    total: opts.total ?? skills.length,
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? 20,
  };
}

function makeRegistrySkill(overrides?: Record<string, unknown>) {
  return {
    source: 'github',
    skillId: 'skill-1',
    name: 'raw-name',
    installs: 42,
    owner: 'acme',
    repo: 'tools',
    githubUrl: 'https://github.com/acme/tools',
    ...overrides,
  };
}

function okJsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function errorResponse(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({}),
  };
}

// ── Setup / teardown ────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── search() ────────────────────────────────────────────────────────────

describe('ExternalSkillProviderHttp — search', () => {
  it('calls GET /api/skills with query, page, pageSize and returns mapped page', async () => {
    const skill = makeRegistrySkill({ displayName: 'Pretty Name' });
    const fetchMock = vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsPageBody([skill], { total: 1, page: 2, pageSize: 10 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const result = await provider.search('crypto', { page: 2, pageSize: 10 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]! as [URL, RequestInit];
    expect(url.toString()).toContain('/api/skills');
    expect(url.searchParams.get('query')).toBe('crypto');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('10');
    expect(opts.signal).toBeDefined();

    expect(result.totalCount).toBe(1);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(10);
    expect(result.results).toHaveLength(1);
  });

  it('returns empty page on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const logger = makeLogger();
    const provider = new ExternalSkillProviderHttp(makeConfig(), logger);

    const result = await provider.search('test', { page: 1, pageSize: 20 });

    expect(result).toEqual({ results: [], totalCount: 0, page: 1, pageSize: 20 });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns empty page on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(500)));
    const logger = makeLogger();
    const provider = new ExternalSkillProviderHttp(makeConfig(), logger);

    const result = await provider.search('test', { page: 1, pageSize: 20 });

    expect(result).toEqual({ results: [], totalCount: 0, page: 1, pageSize: 20 });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns empty page on Zod validation failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJsonResponse({ bad: 'shape' })));
    const logger = makeLogger();
    const provider = new ExternalSkillProviderHttp(makeConfig(), logger);

    const result = await provider.search('test', { page: 3, pageSize: 5 });

    expect(result).toEqual({ results: [], totalCount: 0, page: 3, pageSize: 5 });
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ── browse() ────────────────────────────────────────────────────────────

describe('ExternalSkillProviderHttp — browse', () => {
  it('calls GET /api/skills with sortBy=installs&sortOrder=desc', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsPageBody([], { total: 0, page: 1, pageSize: 20 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    await provider.browse({ page: 1, pageSize: 20 });

    const [url] = fetchMock.mock.calls[0]! as [URL];
    expect(url.searchParams.get('sortBy')).toBe('installs');
    expect(url.searchParams.get('sortOrder')).toBe('desc');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('pageSize')).toBe('20');
    // browse should not have a query param
    expect(url.searchParams.has('query')).toBe(false);
  });

  it('returns empty page on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());

    const result = await provider.browse({ page: 1, pageSize: 10 });

    expect(result).toEqual({ results: [], totalCount: 0, page: 1, pageSize: 10 });
  });

  it('returns empty page on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(503)));
    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());

    const result = await provider.browse({ page: 1, pageSize: 10 });

    expect(result).toEqual({ results: [], totalCount: 0, page: 1, pageSize: 10 });
  });

  it('returns empty page on Zod validation failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJsonResponse({ bad: 'shape' })));
    const logger = makeLogger();
    const provider = new ExternalSkillProviderHttp(makeConfig(), logger);

    const result = await provider.browse({ page: 2, pageSize: 15 });

    expect(result).toEqual({ results: [], totalCount: 0, page: 2, pageSize: 15 });
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ── getStats() ──────────────────────────────────────────────────────────

describe('ExternalSkillProviderHttp — getStats', () => {
  it('fetches stats from /api/skills/stats and returns mapped object', async () => {
    const body = { totalSkills: 100, totalSources: 5, totalOwners: 30 };
    const fetchMock = vi.fn().mockResolvedValue(okJsonResponse(body));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const stats = await provider.getStats();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]! as [string];
    expect(url).toBe('http://skills.local:3000/api/skills/stats');
    expect(stats).toEqual({ totalSkills: 100, totalSources: 5, totalOwners: 30 });
  });

  it('strips extra response fields (scrapedAt, totalInstalls)', async () => {
    const body = {
      totalSkills: 10,
      totalSources: 2,
      totalOwners: 3,
      scrapedAt: '2025-01-01',
      totalInstalls: 9999,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJsonResponse(body)));

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const stats = await provider.getStats();

    expect(stats).toEqual({ totalSkills: 10, totalSources: 2, totalOwners: 3 });
    expect(stats).not.toHaveProperty('scrapedAt');
    expect(stats).not.toHaveProperty('totalInstalls');
  });

  it('returns null on network error when no cache exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const logger = makeLogger();
    const provider = new ExternalSkillProviderHttp(makeConfig(), logger);

    const stats = await provider.getStats();

    expect(stats).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns null on non-2xx response when no cache exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(500)));
    const logger = makeLogger();
    const provider = new ExternalSkillProviderHttp(makeConfig(), logger);

    const stats = await provider.getStats();

    expect(stats).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns null on Zod validation failure when no cache exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJsonResponse({ wrong: 'shape' })));
    const logger = makeLogger();
    const provider = new ExternalSkillProviderHttp(makeConfig(), logger);

    const stats = await provider.getStats();

    expect(stats).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ── Stats caching ───────────────────────────────────────────────────────

describe('ExternalSkillProviderHttp — stats caching', () => {
  it('returns cached stats without re-fetching within TTL', async () => {
    const body = { totalSkills: 50, totalSources: 3, totalOwners: 10 };
    const fetchMock = vi.fn().mockResolvedValue(okJsonResponse(body));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());

    const first = await provider.getStats();
    const second = await provider.getStats();

    expect(first).toEqual({ totalSkills: 50, totalSources: 3, totalOwners: 10 });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after TTL expires', async () => {
    vi.useFakeTimers();

    const body1 = { totalSkills: 50, totalSources: 3, totalOwners: 10 };
    const body2 = { totalSkills: 60, totalSources: 4, totalOwners: 12 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJsonResponse(body1))
      .mockResolvedValueOnce(okJsonResponse(body2));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());

    const first = await provider.getStats();
    expect(first).toEqual({ totalSkills: 50, totalSources: 3, totalOwners: 10 });

    // Advance past the 5-minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const second = await provider.getStats();
    expect(second).toEqual({ totalSkills: 60, totalSources: 4, totalOwners: 12 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('returns stale cache as fallback when re-fetch fails', async () => {
    vi.useFakeTimers();

    const body = { totalSkills: 50, totalSources: 3, totalOwners: 10 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJsonResponse(body))
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const logger = makeLogger();
    const provider = new ExternalSkillProviderHttp(makeConfig(), logger);

    const first = await provider.getStats();
    expect(first).toEqual({ totalSkills: 50, totalSources: 3, totalOwners: 10 });

    // Advance past TTL to make cache stale
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const second = await provider.getStats();
    // Should return stale cached data
    expect(second).toEqual({ totalSkills: 50, totalSources: 3, totalOwners: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('returns stale cache when non-2xx response after TTL', async () => {
    vi.useFakeTimers();

    const body = { totalSkills: 25, totalSources: 2, totalOwners: 5 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJsonResponse(body))
      .mockResolvedValueOnce(errorResponse(502));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());

    await provider.getStats();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const second = await provider.getStats();
    expect(second).toEqual({ totalSkills: 25, totalSources: 2, totalOwners: 5 });

    vi.useRealTimers();
  });

  it('returns stale cache when Zod validation fails after TTL', async () => {
    vi.useFakeTimers();

    const body = { totalSkills: 25, totalSources: 2, totalOwners: 5 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJsonResponse(body))
      .mockResolvedValueOnce(okJsonResponse({ corrupted: true }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());

    await provider.getStats();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const second = await provider.getStats();
    expect(second).toEqual({ totalSkills: 25, totalSources: 2, totalOwners: 5 });

    vi.useRealTimers();
  });
});

// ── Response mapping ────────────────────────────────────────────────────

describe('ExternalSkillProviderHttp — response mapping', () => {
  it('maps ref as owner/repo/skillId', async () => {
    const skill = makeRegistrySkill({ owner: 'org', repo: 'lib', skillId: 'my-skill' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsPageBody([skill])),
    ));

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const result = await provider.search('test', { page: 1, pageSize: 20 });

    expect(result.results[0]!.ref).toBe('org/lib/my-skill');
  });

  it('uses displayName when available', async () => {
    const skill = makeRegistrySkill({ name: 'raw-name', displayName: 'Display Name' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsPageBody([skill])),
    ));

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const result = await provider.search('test', { page: 1, pageSize: 20 });

    expect(result.results[0]!.name).toBe('Display Name');
  });

  it('falls back to raw name when displayName is absent', async () => {
    const skill = makeRegistrySkill({ name: 'raw-name' });
    delete (skill as Record<string, unknown>)['displayName'];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsPageBody([skill])),
    ));

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const result = await provider.search('test', { page: 1, pageSize: 20 });

    expect(result.results[0]!.name).toBe('raw-name');
  });

  it('sets description to empty string', async () => {
    const skill = makeRegistrySkill();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsPageBody([skill])),
    ));

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const result = await provider.search('test', { page: 1, pageSize: 20 });

    expect(result.results[0]!.description).toBe('');
  });

  it('maps all ExternalSkillSummary fields correctly', async () => {
    const skill = makeRegistrySkill({
      owner: 'alice',
      repo: 'toolkit',
      skillId: 'fetch-data',
      name: 'raw',
      displayName: 'Fetch Data Skill',
      installs: 123,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsPageBody([skill])),
    ));

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const result = await provider.search('fetch', { page: 1, pageSize: 20 });

    const mapped = result.results[0]!;
    expect(mapped).toEqual({
      ref: 'alice/toolkit/fetch-data',
      skillId: 'fetch-data',
      name: 'Fetch Data Skill',
      description: '',
      owner: 'alice',
      repo: 'toolkit',
      installs: 123,
    });
    // tags is not provided by skills-api, so it should be absent
    expect(mapped).not.toHaveProperty('tags');
  });

  it('maps multiple skills in a page', async () => {
    const skills = [
      makeRegistrySkill({ skillId: 's1', owner: 'a', repo: 'r' }),
      makeRegistrySkill({ skillId: 's2', owner: 'b', repo: 'r2' }),
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsPageBody(skills, { total: 2 })),
    ));

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const result = await provider.browse({ page: 1, pageSize: 20 });

    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.ref).toBe('a/r/s1');
    expect(result.results[1]!.ref).toBe('b/r2/s2');
    expect(result.totalCount).toBe(2);
  });
});

// ── Constructor / baseUrl normalization ──────────────────────────────────

describe('ExternalSkillProviderHttp — baseUrl normalization', () => {
  it('strips trailing slash from baseUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsPageBody([])),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(
      makeConfig({ baseUrl: 'http://skills.local:3000/' }),
      makeLogger(),
    );
    await provider.search('test', { page: 1, pageSize: 10 });

    const [url] = fetchMock.mock.calls[0]! as [URL];
    // Should not have double slash
    expect(url.toString()).toContain('http://skills.local:3000/api/skills');
    expect(url.toString()).not.toContain('//api');
  });
});

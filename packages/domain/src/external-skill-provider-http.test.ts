import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExternalSkillProviderHttp } from './external-skill-provider-http.js';
import type { ExternalSkillProviderHttpConfig, ProviderLogger } from './external-skill-provider-http.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<ExternalSkillProviderHttpConfig>): ExternalSkillProviderHttpConfig {
  return {
    baseUrl: 'http://mastra.local:3456',
    searchApiBaseUrl: 'https://skills.sh',
    searchTimeoutMs: 5000,
    browseTimeoutMs: 5000,
    statsTimeoutMs: 3000,
    ...overrides,
  };
}

function makeLogger(): ProviderLogger {
  return { warn: vi.fn() } as unknown as ProviderLogger;
}

/** skills.sh /api/search response body */
function makeSkillsShSearchBody(
  skills: Array<Record<string, unknown>> = [],
) {
  return {
    query: 'test',
    searchType: 'fuzzy',
    searchVersion: 'legacy',
    skills,
    count: skills.length,
    duration_ms: 100,
  };
}

function makeSkillsShSkill(overrides?: Record<string, unknown>) {
  return {
    id: 'acme/tools/skill-1',
    skillId: 'skill-1',
    name: 'skill-1',
    installs: 42,
    source: 'acme/tools',
    ...overrides,
  };
}

/** @mastra/skills-api page response body */
function makeMastraPageBody(
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

function makeMastraSkill(overrides?: Record<string, unknown>) {
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

// ── search() — routes to skills.sh ─────────────────────────────────────

describe('ExternalSkillProviderHttp — search (skills.sh)', () => {
  it('calls skills.sh /api/search with query and limit=200', async () => {
    const skill = makeSkillsShSkill();
    const fetchMock = vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsShSearchBody([skill])),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const result = await provider.search('crypto', { page: 1, pageSize: 10 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]! as [URL];
    expect(url.toString()).toContain('skills.sh/api/search');
    expect(url.searchParams.get('q')).toBe('crypto');
    expect(url.searchParams.get('limit')).toBe('200');

    expect(result.results).toHaveLength(1);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
  });

  it('slices results for requested page from cached 200-result window', async () => {
    // Create 5 skills to simulate a result set
    const skills = Array.from({ length: 5 }, (_, i) =>
      makeSkillsShSkill({ id: `o/r/s${i}`, skillId: `s${i}`, name: `skill-${i}`, installs: 100 - i, source: 'o/r' }),
    );
    const fetchMock = vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsShSearchBody(skills)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());

    // Page 1, size 2 → first 2 skills
    const p1 = await provider.search('test', { page: 1, pageSize: 2 });
    expect(p1.results).toHaveLength(2);
    expect(p1.results[0]!.skillId).toBe('s0');
    expect(p1.results[1]!.skillId).toBe('s1');

    // Page 2, size 2 → next 2 skills (from cache, no re-fetch)
    const p2 = await provider.search('test', { page: 2, pageSize: 2 });
    expect(p2.results).toHaveLength(2);
    expect(p2.results[0]!.skillId).toBe('s2');
    expect(p2.results[1]!.skillId).toBe('s3');

    // Page 3, size 2 → last 1 skill
    const p3 = await provider.search('test', { page: 3, pageSize: 2 });
    expect(p3.results).toHaveLength(1);
    expect(p3.results[0]!.skillId).toBe('s4');

    // Only 1 fetch call — subsequent pages served from cache
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps skills.sh response to ExternalSkillSummary', async () => {
    const skill = makeSkillsShSkill({
      id: 'google/agents-cli/google-adk',
      skillId: 'google-adk',
      name: 'google-adk',
      installs: 110000,
      source: 'google/agents-cli',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsShSearchBody([skill])),
    ));

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const result = await provider.search('google', { page: 1, pageSize: 20 });

    const mapped = result.results[0]!;
    expect(mapped.ref).toBe('google/agents-cli/google-adk');
    expect(mapped.skillId).toBe('google-adk');
    expect(mapped.name).toBe('google-adk');
    expect(mapped.owner).toBe('google');
    expect(mapped.repo).toBe('agents-cli');
    expect(mapped.installs).toBe(110000);
    expect(mapped.description).toBe('');
  });

  it('returns totalCount as the number of results from skills.sh', async () => {
    const skills = Array.from({ length: 15 }, (_, i) =>
      makeSkillsShSkill({ id: `o/r/s${i}`, skillId: `s${i}`, source: 'o/r' }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsShSearchBody(skills)),
    ));

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const result = await provider.search('test', { page: 1, pageSize: 5 });

    expect(result.totalCount).toBe(15);
    expect(result.results).toHaveLength(5);
  });

  it('falls back to mastra search on network error', async () => {
    const mastraSkill = makeMastraSkill({ skillId: 'fallback-skill', displayName: 'Fallback' });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))                              // skills.sh fails
      .mockResolvedValueOnce(okJsonResponse(makeMastraPageBody([mastraSkill], { total: 1 }))); // mastra fallback
    vi.stubGlobal('fetch', fetchMock);

    const logger = makeLogger();
    const provider = new ExternalSkillProviderHttp(makeConfig(), logger);
    const result = await provider.search('test', { page: 1, pageSize: 20 });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.skillId).toBe('fallback-skill');
    expect(logger.warn).toHaveBeenCalled();
    // Two fetch calls: skills.sh (failed) + mastra (fallback)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [mastraUrl] = fetchMock.mock.calls[1]! as [URL];
    expect(mastraUrl.toString()).toContain('mastra.local:3456/api/skills');
    expect(mastraUrl.searchParams.get('query')).toBe('test');
  });

  it('falls back to mastra search on non-2xx response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(429))                                       // skills.sh 429
      .mockResolvedValueOnce(okJsonResponse(makeMastraPageBody([], { total: 0 })));    // mastra fallback
    vi.stubGlobal('fetch', fetchMock);

    const logger = makeLogger();
    const provider = new ExternalSkillProviderHttp(makeConfig(), logger);
    const result = await provider.search('test', { page: 1, pageSize: 20 });

    expect(result.results).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to mastra search on Zod validation failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJsonResponse({ bad: 'shape' }))                          // skills.sh bad response
      .mockResolvedValueOnce(okJsonResponse(makeMastraPageBody([], { total: 0 })));     // mastra fallback
    vi.stubGlobal('fetch', fetchMock);

    const logger = makeLogger();
    const provider = new ExternalSkillProviderHttp(makeConfig(), logger);
    const result = await provider.search('test', { page: 1, pageSize: 5 });

    expect(result.results).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns stale cache instead of falling back to mastra when cache exists for same query', async () => {
    vi.useFakeTimers();

    const cachedSkill = makeSkillsShSkill({ id: 'o/r/cached', skillId: 'cached', source: 'o/r' });
    const fetchMock = vi.fn()
      // First call: skills.sh succeeds → populates cache
      .mockResolvedValueOnce(okJsonResponse(makeSkillsShSearchBody([cachedSkill])))
      // Second call: skills.sh fails (cache is stale but still present)
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());

    // Populate the cache
    const first = await provider.search('test', { page: 1, pageSize: 20 });
    expect(first.results).toHaveLength(1);
    expect(first.results[0]!.skillId).toBe('cached');

    // Advance past the 60s search cache TTL so fetchSkillsShSearch re-fetches
    vi.advanceTimersByTime(61_000);

    // skills.sh fails but stale cache is returned — no mastra fallback
    const second = await provider.search('test', { page: 1, pageSize: 20 });
    expect(second.results).toHaveLength(1);
    expect(second.results[0]!.skillId).toBe('cached');

    // 2 fetch calls: initial skills.sh + failed retry after TTL. No mastra call.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('returns empty page when both skills.sh and mastra fail', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('skills.sh down'))                             // skills.sh fails
      .mockRejectedValueOnce(new Error('mastra down'));                               // mastra fallback also fails
    vi.stubGlobal('fetch', fetchMock);

    const logger = makeLogger();
    const provider = new ExternalSkillProviderHttp(makeConfig(), logger);
    const result = await provider.search('test', { page: 1, pageSize: 20 });

    expect(result).toEqual({ results: [], totalCount: 0, page: 1, pageSize: 20 });
    expect(logger.warn).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns empty slice for page beyond results', async () => {
    const skills = [makeSkillsShSkill()];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsShSearchBody(skills)),
    ));

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const result = await provider.search('test', { page: 10, pageSize: 20 });

    expect(result.results).toHaveLength(0);
    expect(result.totalCount).toBe(1);
  });
});

// ── browse() — routes to @mastra/skills-api ─────────────────────────────

describe('ExternalSkillProviderHttp — browse (mastra)', () => {
  it('calls mastra /api/skills with sortBy=installs&sortOrder=desc', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJsonResponse(makeMastraPageBody([], { total: 0, page: 1, pageSize: 20 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    await provider.browse({ page: 1, pageSize: 20 });

    const [url] = fetchMock.mock.calls[0]! as [URL];
    expect(url.toString()).toContain('mastra.local:3456/api/skills');
    expect(url.searchParams.get('sortBy')).toBe('installs');
    expect(url.searchParams.get('sortOrder')).toBe('desc');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('pageSize')).toBe('20');
  });

  it('maps mastra response with displayName', async () => {
    const skill = makeMastraSkill({ displayName: 'Pretty Name', owner: 'org', repo: 'lib', skillId: 'my-skill' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJsonResponse(makeMastraPageBody([skill], { total: 1 })),
    ));

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const result = await provider.browse({ page: 1, pageSize: 20 });

    expect(result.results[0]!.name).toBe('Pretty Name');
    expect(result.results[0]!.ref).toBe('org/lib/my-skill');
    expect(result.totalCount).toBe(1);
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

// ── getStats() — routes to @mastra/skills-api ───────────────────────────

describe('ExternalSkillProviderHttp — getStats (mastra)', () => {
  it('fetches stats from mastra /api/skills/stats', async () => {
    const body = { totalSkills: 100, totalSources: 5, totalOwners: 30 };
    const fetchMock = vi.fn().mockResolvedValue(okJsonResponse(body));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(makeConfig(), makeLogger());
    const stats = await provider.getStats();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]! as [string];
    expect(url).toBe('http://mastra.local:3456/api/skills/stats');
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

    await provider.getStats();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const second = await provider.getStats();
    expect(second).toEqual({ totalSkills: 50, totalSources: 3, totalOwners: 10 });
    expect(logger.warn).toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ── baseUrl normalization ───────────────────────────────────────────────

describe('ExternalSkillProviderHttp — baseUrl normalization', () => {
  it('strips trailing slash from baseUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJsonResponse(makeMastraPageBody([])),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(
      makeConfig({ baseUrl: 'http://mastra.local:3456/' }),
      makeLogger(),
    );
    await provider.browse({ page: 1, pageSize: 10 });

    const [url] = fetchMock.mock.calls[0]! as [URL];
    expect(url.toString()).not.toContain('//api');
  });

  it('strips trailing slash from searchApiBaseUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJsonResponse(makeSkillsShSearchBody([])),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalSkillProviderHttp(
      makeConfig({ searchApiBaseUrl: 'https://skills.sh/' }),
      makeLogger(),
    );
    await provider.search('test', { page: 1, pageSize: 10 });

    const [url] = fetchMock.mock.calls[0]! as [URL];
    expect(url.toString()).toContain('skills.sh/api/search');
    expect(url.toString()).not.toContain('//api');
  });
});

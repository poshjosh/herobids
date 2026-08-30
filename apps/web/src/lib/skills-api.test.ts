/**
 * Tests for skills.list() query string building.
 *
 * Verifies that the new parameters (sourceKind, page, pageSize) are correctly
 * serialised into the URL query string, and that the paginated response shape
 * is returned.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// ── Browser global stubs ─────────────────────────────────────────────────────
vi.stubGlobal('window', { location: { href: '' } });

import { skills, type Skill } from './api-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture the URL from fetch and return a canned skills response. */
function mockFetchCapture(response?: Partial<{ skills: Skill[]; totalCount: number; page: number; pageSize: number; degradation?: { external: string; reason: string } }>) {
  const calls: string[] = [];
  const body = {
    skills: [],
    totalCount: 0,
    page: 1,
    pageSize: 20,
    ...response,
  };

  vi.stubGlobal(
    'fetch',
    vi.fn((...args: Parameters<typeof fetch>) => {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;
      calls.push(url);
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve(body),
      } as Response);
    }),
  );

  return calls;
}

function extractQuery(fullUrl: string): URLSearchParams {
  const qIndex = fullUrl.indexOf('?');
  return new URLSearchParams(qIndex >= 0 ? fullUrl.slice(qIndex) : '');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

describe('skills.list() — query string building', () => {
  it('calls /skills with no query string when no params are provided', async () => {
    const calls = mockFetchCapture();
    await skills.list();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\/skills$/);
  });

  it('includes scope in the query string', async () => {
    const calls = mockFetchCapture();
    await skills.list({ scope: 'selectable' });
    const params = extractQuery(calls[0]!);
    expect(params.get('scope')).toBe('selectable');
  });

  it('includes sourceKind in the query string', async () => {
    const calls = mockFetchCapture();
    await skills.list({ sourceKind: 'system' });
    const params = extractQuery(calls[0]!);
    expect(params.get('sourceKind')).toBe('system');
  });

  it('includes the new "external" sourceKind value', async () => {
    const calls = mockFetchCapture();
    await skills.list({ sourceKind: 'external' });
    const params = extractQuery(calls[0]!);
    expect(params.get('sourceKind')).toBe('external');
  });

  it('includes page and pageSize in the query string', async () => {
    const calls = mockFetchCapture();
    await skills.list({ page: 3, pageSize: 20 });
    const params = extractQuery(calls[0]!);
    expect(params.get('page')).toBe('3');
    expect(params.get('pageSize')).toBe('20');
  });

  it('includes page=0 in the query string (zero is a valid value, not omitted)', async () => {
    const calls = mockFetchCapture();
    await skills.list({ page: 0 });
    const params = extractQuery(calls[0]!);
    expect(params.get('page')).toBe('0');
  });

  it('includes pageSize=0 in the query string', async () => {
    const calls = mockFetchCapture();
    await skills.list({ pageSize: 0 });
    const params = extractQuery(calls[0]!);
    expect(params.get('pageSize')).toBe('0');
  });

  it('combines multiple params into one query string', async () => {
    const calls = mockFetchCapture();
    await skills.list({
      scope: 'marketplace',
      sourceKind: 'external',
      sort: 'popular',
      page: 2,
      pageSize: 10,
    });
    const params = extractQuery(calls[0]!);
    expect(params.get('scope')).toBe('marketplace');
    expect(params.get('sourceKind')).toBe('external');
    expect(params.get('sort')).toBe('popular');
    expect(params.get('page')).toBe('2');
    expect(params.get('pageSize')).toBe('10');
  });

  it('omits undefined optional params from the query string', async () => {
    const calls = mockFetchCapture();
    await skills.list({ scope: 'mine' });
    const params = extractQuery(calls[0]!);
    expect(params.has('sourceKind')).toBe(false);
    expect(params.has('page')).toBe(false);
    expect(params.has('pageSize')).toBe(false);
    expect(params.has('sort')).toBe(false);
    expect(params.has('tag')).toBe(false);
  });

  it('returns the paginated response shape including totalCount', async () => {
    mockFetchCapture({ totalCount: 142, page: 2, pageSize: 20 });
    const result = await skills.list({ page: 2, pageSize: 20 });
    expect(result.totalCount).toBe(142);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(20);
  });

  it('returns degradation info when present in the response', async () => {
    mockFetchCapture({
      degradation: { external: 'marketplace', reason: 'timeout' },
    });
    const result = await skills.list({ scope: 'selectable' });
    expect(result.degradation).toEqual({ external: 'marketplace', reason: 'timeout' });
  });

  it('omits degradation from the result when not present in the response', async () => {
    mockFetchCapture();
    const result = await skills.list({ scope: 'selectable' });
    expect(result.degradation).toBeUndefined();
  });

  it('includes the builtIn query pattern used by SkillsPage (scope=selectable, sourceKind=system)', async () => {
    const calls = mockFetchCapture();
    await skills.list({ scope: 'selectable', sourceKind: 'system' });
    const params = extractQuery(calls[0]!);
    expect(params.get('scope')).toBe('selectable');
    expect(params.get('sourceKind')).toBe('system');
  });
});

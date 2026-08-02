import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { platformDocsTools } from './platform-docs.js';

const searchAppDocs = platformDocsTools.find((t) => t.name === 'search_app_docs')!;
const listAppDocs = platformDocsTools.find((t) => t.name === 'list_app_docs')!;
const readAppDocs = platformDocsTools.find((t) => t.name === 'read_app_docs')!;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

// ─── search_app_docs ──────────────────────────────────────────────────────

describe('search_app_docs', () => {
  // -------------------------------------------------------------------------
  // Basic matching
  // -------------------------------------------------------------------------

  it('finds docs by single-word query', async () => {
    const ctx = makeCtx();

    const result = await searchAppDocs.execute({ query: 'Hyperliquid' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.ok).toBe(true);
    const results = data.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);
    // At least one result should mention Hyperliquid
    const hasHyperliquid = results.some(
      (r) =>
        (r.title as string).toLowerCase().includes('hyperliquid') ||
        (r.excerpt as string).toLowerCase().includes('hyperliquid'),
    );
    expect(hasHyperliquid).toBe(true);
  });

  it('finds docs by multi-word tokenized query', async () => {
    const ctx = makeCtx();

    // These words appear across different docs — tokenization should
    // find entries matching any of them, ranked by coverage.
    const result = await searchAppDocs.execute({ query: 'venue trading connection' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Stemming
  // -------------------------------------------------------------------------

  it('matches "venues" to docs containing "venue" via stemming', async () => {
    const ctx = makeCtx();

    // Query only the plural form — no unstemmed fallback word.
    // "venues" stems to "venue"; docs with "venue" in title/ID
    // like mapping/venue-chain should appear even though they
    // don't contain the exact token "venues" in every field.
    const result = await searchAppDocs.execute({ query: 'venues', maxResults: 20 }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);

    const ids = results.map((r) => r.id as string);
    // help/trading-venues/index has "venues" in the title — should rank high
    expect(ids).toContain('help/trading-venues/index');
    // mapping/venue-chain has "venue" in its ID — reachable via stemming
    expect(ids).toContain('mapping/venue-chain');
  });

  it('matches "strategies" to docs containing "strategy" via stemming', async () => {
    const ctx = makeCtx();

    // "strategies" stems to "strategy" via -ies → -y rule.
    // Strategy-related docs (presets, trading skill, etc.) use "strategy"
    // not "strategies" throughout.
    const result = await searchAppDocs.execute({ query: 'strategies', maxResults: 20 }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);

    const ids = results.map((r) => r.id as string);
    // CreateAgentSchema has "strategyPreset" — "strategies" cannot
    // substring-match that (ie vs y), so only the stem "strategy" can bridge it.
    expect(ids).toContain('schema/CreateAgentSchema');
  });

  it('matches "configuration" to docs containing "configure" via stemming', async () => {
    const ctx = makeCtx();

    // "configuration" stems to "configure" via -ation → -e rule.
    const result = await searchAppDocs.execute({ query: 'configuration', maxResults: 20 }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);

    const ids = results.map((r) => r.id as string);
    // CreateAgentSchema has fields like "strategyPreset" — config-related
    expect(ids).toContain('schema/CreateAgentSchema');
  });

  it('filters stopwords and short tokens to avoid noise', async () => {
    const ctx = makeCtx();

    // "what", "is", "the", "a" are all stopwords or < 2 chars.
    // Only "billing" should contribute to scoring.
    const result = await searchAppDocs.execute({ query: 'what is the billing model', maxResults: 10 }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);

    // The billing-model doc should rank at or near the top since "billing"
    // is the only scoring token and it matches the title.
    const ids = results.map((r) => r.id as string);
    expect(ids).toContain('reference/billing-model');
    // Should be the first result — no stopword noise to push it down
    expect(ids[0]).toBe('reference/billing-model');
  });

  // -------------------------------------------------------------------------
  // Ranking: title matches outrank content-only matches
  // -------------------------------------------------------------------------

  it('ranks multi-token title matches above single-token content matches', async () => {
    const ctx = makeCtx();

    // "billing" appears in the title of reference/billing-model.
    // "agent" appears in many doc titles and content.
    // Docs matching both tokens in high-value fields should rank first.
    const result = await searchAppDocs.execute({ query: 'agent billing', maxResults: 10 }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);

    // The billing model doc should appear in results
    const billingIdx = results.findIndex((r) => r.id === 'reference/billing-model');
    expect(billingIdx).not.toBe(-1);

    // Verify results are sorted by score descending (first result has highest score)
    // by checking that all matchType values are consistent with ranking:
    // title matches should generally precede content-only matches
    const firstContentOnly = results.findIndex((r) => r.matchType === 'content');
    const lastTitle = results.map((r) => r.matchType).lastIndexOf('title');
    if (firstContentOnly !== -1 && lastTitle !== -1) {
      expect(lastTitle).toBeLessThan(firstContentOnly);
    }
  });

  // -------------------------------------------------------------------------
  // kind filter
  // -------------------------------------------------------------------------

  it('filters results by kind', async () => {
    const ctx = makeCtx();

    const result = await searchAppDocs.execute({ query: 'agent', kind: 'reference', maxResults: 20 }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    for (const r of results) {
      expect(r.kind).toBe('reference');
    }
  });

  // -------------------------------------------------------------------------
  // maxResults
  // -------------------------------------------------------------------------

  it('respects maxResults cap', async () => {
    const ctx = makeCtx();

    const result = await searchAppDocs.execute({ query: 'agent', maxResults: 2 }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    expect(results.length).toBeLessThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // No results
  // -------------------------------------------------------------------------

  it('returns empty results with hint for unmatched query', async () => {
    const ctx = makeCtx();

    const result = await searchAppDocs.execute({ query: 'xyznonexistent12345' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.ok).toBe(true);
    const results = data.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(0);
    expect(data.hint).toContain('No results found');
  });

  // -------------------------------------------------------------------------
  // Excerpt presence
  // -------------------------------------------------------------------------

  it('includes an excerpt in every result', async () => {
    const ctx = makeCtx();

    const result = await searchAppDocs.execute({ query: 'agent' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.excerpt).toBeDefined();
      expect(typeof r.excerpt).toBe('string');
      expect((r.excerpt as string).length).toBeGreaterThan(0);
    }
  });
});

// ─── list_app_docs ────────────────────────────────────────────────────────

describe('list_app_docs', () => {
  it('returns all entries when no kind filter', async () => {
    const ctx = makeCtx();

    const result = await listAppDocs.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.ok).toBe(true);
    const entries = data.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);

    // Each entry must have id, title, kind, headings, tags
    for (const e of entries) {
      expect(e.id).toBeDefined();
      expect(e.title).toBeDefined();
      expect(e.kind).toBeDefined();
      expect(Array.isArray(e.headings)).toBe(true);
      expect(Array.isArray(e.tags)).toBe(true);
    }

    // Should NOT include full content
    for (const e of entries) {
      expect(e).not.toHaveProperty('content');
    }
  });

  it('filters by kind', async () => {
    const ctx = makeCtx();

    const result = await listAppDocs.execute({ kind: 'schema' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const entries = data.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.kind).toBe('schema');
    }
  });

  it('returns totalEntries count', async () => {
    const ctx = makeCtx();

    const result = await listAppDocs.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.totalEntries).toBeGreaterThan(0);
    const entries = data.entries as Array<Record<string, unknown>>;
    expect(data.totalEntries).toBe(entries.length);
  });
});

// ─── read_app_docs ────────────────────────────────────────────────────────

describe('read_app_docs', () => {
  it('returns a full document by ID', async () => {
    const ctx = makeCtx();

    const result = await readAppDocs.execute({ id: 'reference/billing-model' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.id).toBe('reference/billing-model');
    expect(data.title).toBeDefined();
    expect(data.kind).toBeDefined();
    expect(data.content).toBeDefined();
    expect(typeof data.content).toBe('string');
    expect((data.content as string).length).toBeGreaterThan(0);
  });

  it('returns a schema doc with content', async () => {
    const ctx = makeCtx();

    const result = await readAppDocs.execute({ id: 'schema/CreateAgentSchema' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.id).toBe('schema/CreateAgentSchema');
    expect(data.kind).toBe('schema');
  });

  it('returns error for unknown doc ID', async () => {
    const ctx = makeCtx();

    const result = await readAppDocs.execute({ id: 'nonexistent/doc' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('docs.not_found');
    expect(result.error).toContain('nonexistent/doc');

    // Should include available IDs as a hint
    const data = result.data as Record<string, unknown> | undefined;
    expect(data).toBeDefined();
    expect(data!.availableIds).toBeDefined();
    expect(Array.isArray(data!.availableIds)).toBe(true);
    expect((data!.availableIds as string[]).length).toBeGreaterThan(0);
  });
});

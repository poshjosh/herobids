import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { tokenize, expandToken } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { PLATFORM_DOCS_INDEX, type DocsIndexEntry } from './platform-docs-data.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  title: string;
  kind: DocsIndexEntry['kind'];
  headings: string[];
  tags: string[];
  excerpt: string;
  matchType: 'title' | 'heading' | 'content' | 'tag';
}

const EXCERPT_MAX_LENGTH = 200;

// ─── Scoring ────────────────────────────────────────────────────────────────

const FIELD_WEIGHTS: Record<SearchResult['matchType'], number> = {
  title: 30,
  heading: 20,
  tag: 15,
  content: 5,
};

const FIELD_RANK: Record<SearchResult['matchType'], number> = {
  title: 0,
  heading: 1,
  tag: 2,
  content: 3,
};

interface TokenHit {
  token: string;
  matchType: SearchResult['matchType'];
}

/**
 * Determine the best matching field for a single form across all
 * searchable fields. Returns the highest-ranked field that
 * contains the form, or null if no field matches.
 */
function bestFieldForForm(
  form: string,
  lowerTitle: string,
  lowerHeadings: string[],
  lowerTags: string[],
  lowerContent: string,
): SearchResult['matchType'] | null {
  if (lowerTitle.includes(form)) return 'title';
  if (lowerHeadings.some((h) => h.includes(form))) return 'heading';
  if (lowerTags.some((t) => t.includes(form))) return 'tag';
  if (lowerContent.includes(form)) return 'content';
  return null;
}

/**
 * Score an entry against the original query tokens.
 * Each original token scores exactly ONCE, earning the weight
 * of its best matching field across all expanded forms (original + stem).
 * This prevents double-counting: "trading" matching in both title
 * and content gets title points only, and its stem "trad" does not
 * earn a second score event.
 */
function scoreEntry(
  entry: DocsIndexEntry,
  originalTokens: string[],
): { score: number; matchType: SearchResult['matchType']; hits: TokenHit[] } {
  const lowerTitle = entry.title.toLowerCase();
  const lowerContent = entry.content.toLowerCase();
  const lowerHeadings = entry.headings.map((h) => h.toLowerCase());
  const lowerTags = entry.tags.map((t) => t.toLowerCase());

  const hits: TokenHit[] = [];
  let score = 0;
  let bestMatchType: SearchResult['matchType'] = 'content';

  for (const token of originalTokens) {
    const forms = expandToken(token);

    // Find the best field any form of this token matches in
    let bestField: SearchResult['matchType'] | null = null;
    let bestForm: string | null = null;

    for (const form of forms) {
      const field = bestFieldForForm(form, lowerTitle, lowerHeadings, lowerTags, lowerContent);
      if (field !== null && (bestField === null || FIELD_RANK[field] < FIELD_RANK[bestField])) {
        bestField = field;
        bestForm = form;
      }
    }

    if (bestField !== null && bestForm !== null) {
      score += FIELD_WEIGHTS[bestField];
      hits.push({ token: bestForm, matchType: bestField });
      if (FIELD_RANK[bestField] < FIELD_RANK[bestMatchType]) {
        bestMatchType = bestField;
      }
    }
  }

  return { score, matchType: bestMatchType, hits };
}

// ─── Excerpt ────────────────────────────────────────────────────────────────

/**
 * Build an excerpt showing the region of the document with the
 * highest density of matched tokens.
 */
function excerpt(content: string, hits: TokenHit[]): string {
  if (hits.length === 0) {
    return content.slice(0, EXCERPT_MAX_LENGTH).trim() + '…';
  }

  const lowerContent = content.toLowerCase();

  // Find all hit positions in the content
  const positions: number[] = [];
  for (const hit of hits) {
    let idx = lowerContent.indexOf(hit.token);
    while (idx !== -1) {
      positions.push(idx);
      idx = lowerContent.indexOf(hit.token, idx + 1);
    }
  }

  if (positions.length === 0) {
    return content.slice(0, EXCERPT_MAX_LENGTH).trim() + '…';
  }

  // Find the densest window: the region of EXCERPT_MAX_LENGTH chars
  // that contains the most hit positions
  positions.sort((a, b) => a - b);
  let bestStart = 0;
  let bestCount = 0;

  for (const pos of positions) {
    const windowStart = Math.max(0, pos - 60);
    const windowEnd = windowStart + EXCERPT_MAX_LENGTH;
    const count = positions.filter((p) => p >= windowStart && p < windowEnd).length;
    if (count > bestCount) {
      bestCount = count;
      bestStart = windowStart;
    }
  }

  const end = Math.min(content.length, bestStart + EXCERPT_MAX_LENGTH);
  let snippet = content.slice(bestStart, end).trim();
  if (bestStart > 0) snippet = '…' + snippet;
  if (end < content.length) snippet = snippet + '…';
  return snippet;
}

// ─── Search ─────────────────────────────────────────────────────────────────

function searchDocs(query: string, kind?: string, maxResults = 10): SearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const scored: Array<SearchResult & { score: number }> = [];

  for (const entry of PLATFORM_DOCS_INDEX) {
    if (kind && entry.kind !== kind) continue;

    const { score, matchType, hits } = scoreEntry(entry, tokens);
    if (score === 0) continue;

    scored.push({
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      headings: entry.headings,
      tags: entry.tags,
      excerpt: excerpt(entry.content, hits),
      matchType,
      score,
    });
  }

  // Sort by score descending, then by title for stable ordering
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  return scored.slice(0, maxResults);
}

// ─── search_app_docs ────────────────────────────────────────────────────────

const SearchAppDocsParamsSchema = z.object({
  query: z.string().min(1).max(500).describe('Search query for platform docs, schemas, and mappings.'),
  kind: z.enum(['markdown', 'schema', 'mapping', 'faq', 'reference']).optional().describe('Filter by content type.'),
  // coerce: LLMs may send numbers as strings (e.g. "10")
  maxResults: z.coerce.number().int().min(1).max(50).optional().default(10).describe('Maximum number of results to return.'),
});

const searchAppDocsTool: AgentTool = {
  name: 'search_app_docs',
  description: 'Search platform docs, schemas, and mappings. Returns ranked results with excerpts. Use this to find documentation about platform features, agent configuration, connection types, venue options, and risk settings.',
  parametersSchema: SearchAppDocsParamsSchema,
  parameters: convertZodToJsonSchema(SearchAppDocsParamsSchema),
  category: 'read-config',
  promptGuidance: 'search_app_docs(query) searches across all platform docs. Use list_app_docs to browse all available topics, then read_app_docs(id) to get full details.',
  async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { query, kind, maxResults } = params as z.infer<typeof SearchAppDocsParamsSchema>;
    const results = searchDocs(query, kind, maxResults);

    if (results.length === 0) {
      return {
        success: true,
        data: {
          ok: true,
          query,
          results: [],
          hint: 'No results found. Try a different query or use list_app_docs to browse all available documentation.',
        },
      };
    }

    return {
      success: true,
      data: {
        ok: true,
        query,
        totalResults: results.length,
        results: results.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          headings: r.headings,
          tags: r.tags,
          excerpt: r.excerpt,
          matchType: r.matchType,
        })),
      },
    };
  },
};

// ─── list_app_docs ──────────────────────────────────────────────────────────

const ListAppDocsParamsSchema = z.object({
  kind: z.enum(['markdown', 'schema', 'mapping', 'faq', 'reference']).optional().describe('Filter by content type.'),
});

const listAppDocsTool: AgentTool = {
  name: 'list_app_docs',
  description: 'List all available documentation pages, schemas, and reference materials. Returns summaries (id, title, kind, headings, tags) without full content. Use this to discover what topics are available before reading specific docs.',
  parametersSchema: ListAppDocsParamsSchema,
  parameters: convertZodToJsonSchema(ListAppDocsParamsSchema),
  category: 'read-config',
  promptGuidance: 'list_app_docs() returns all available docs with summaries. Filter by kind to narrow results. Use read_app_docs(id) to get the full content of any entry.',
  async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { kind } = params as z.infer<typeof ListAppDocsParamsSchema>;

    const entries = kind
      ? PLATFORM_DOCS_INDEX.filter((e) => e.kind === kind)
      : PLATFORM_DOCS_INDEX;

    return {
      success: true,
      data: {
        ok: true,
        totalEntries: entries.length,
        entries: entries.map((e) => ({
          id: e.id,
          title: e.title,
          kind: e.kind,
          headings: e.headings,
          tags: e.tags,
        })),
      },
    };
  },
};

// ─── read_app_docs ──────────────────────────────────────────────────────────

const ReadAppDocsParamsSchema = z.object({
  id: z.string().min(1).max(500).describe('The path ID of the document to read (from list_app_docs or search_app_docs results).'),
});

const readAppDocsTool: AgentTool = {
  name: 'read_app_docs',
  description: 'Read a specific documentation page or schema by its path ID. Returns the full content of a single entry. Call this after discovering entries via list_app_docs or search_app_docs.',
  parametersSchema: ReadAppDocsParamsSchema,
  parameters: convertZodToJsonSchema(ReadAppDocsParamsSchema),
  category: 'read-config',
  promptGuidance: 'read_app_docs(id) returns the full content of a single doc. Use list_app_docs or search_app_docs first to find the id of the document you need.',
  async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { id } = params as z.infer<typeof ReadAppDocsParamsSchema>;

    const entry = PLATFORM_DOCS_INDEX.find((e) => e.id === id);

    if (!entry) {
      const availableIds = PLATFORM_DOCS_INDEX.map((e) => e.id);
      return {
        success: false,
        fault: false,
        error: `Unknown document: "${id}". Use list_app_docs to see available documents.`,
        errorCode: 'docs.not_found',
        data: { availableIds },
      };
    }

    return {
      success: true,
      data: {
        ok: true,
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        headings: entry.headings,
        tags: entry.tags,
        content: entry.content,
      },
    };
  },
};

// ─── Exports ────────────────────────────────────────────────────────────────

export const platformDocsTools: AgentTool[] = [
  searchAppDocsTool,
  listAppDocsTool,
  readAppDocsTool,
];

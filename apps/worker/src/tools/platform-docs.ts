import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
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

function excerpt(content: string, query: string): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerContent.indexOf(lowerQuery);
  if (idx === -1) {
    return content.slice(0, EXCERPT_MAX_LENGTH).trim() + '…';
  }
  const start = Math.max(0, idx - 60);
  const end = Math.min(content.length, idx + query.length + 60);
  let snippet = content.slice(start, end).trim();
  if (start > 0) snippet = '…' + snippet;
  if (end < content.length) snippet = snippet + '…';
  return snippet;
}

function rank(results: SearchResult[]): SearchResult[] {
  const order: Record<SearchResult['matchType'], number> = {
    title: 0,
    heading: 1,
    tag: 2,
    content: 3,
  };
  return results.sort((a, b) => order[a.matchType] - order[b.matchType]);
}

function searchDocs(query: string, kind?: string, maxResults = 10): SearchResult[] {
  const lowerQuery = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const entry of PLATFORM_DOCS_INDEX) {
    if (kind && entry.kind !== kind) continue;

    const lowerTitle = entry.title.toLowerCase();
    const lowerContent = entry.content.toLowerCase();

    // Title match
    if (lowerTitle.includes(lowerQuery)) {
      results.push({
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        headings: entry.headings,
        tags: entry.tags,
        excerpt: excerpt(entry.content, query),
        matchType: 'title',
      });
      continue;
    }

    // Heading match
    const matchedHeading = entry.headings.find((h) => h.toLowerCase().includes(lowerQuery));
    if (matchedHeading) {
      results.push({
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        headings: entry.headings,
        tags: entry.tags,
        excerpt: excerpt(entry.content, query),
        matchType: 'heading',
      });
      continue;
    }

    // Tag match
    const matchedTag = entry.tags.find((t) => t.toLowerCase().includes(lowerQuery));
    if (matchedTag) {
      results.push({
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        headings: entry.headings,
        tags: entry.tags,
        excerpt: excerpt(entry.content, query),
        matchType: 'tag',
      });
      continue;
    }

    // Content match
    if (lowerContent.includes(lowerQuery)) {
      results.push({
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        headings: entry.headings,
        tags: entry.tags,
        excerpt: excerpt(entry.content, query),
        matchType: 'content',
      });
    }
  }

  return rank(results).slice(0, maxResults);
}

// ─── search_app_docs ────────────────────────────────────────────────────────

const SearchAppDocsParamsSchema = z.object({
  query: z.string().min(1).max(500).describe('Search query for platform docs, schemas, and mappings.'),
  kind: z.enum(['markdown', 'schema', 'mapping', 'faq', 'reference']).optional().describe('Filter by content type.'),
  maxResults: z.number().int().min(1).max(50).optional().default(10).describe('Maximum number of results to return.'),
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

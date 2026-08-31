/**
 * Hybrid ExternalSkillProvider implementation.
 *
 * Search: routes through the public skills.sh API (600k+ skills, no auth).
 * Browse + stats: routes through a self-hosted @mastra/skills-api instance (34k+).
 *
 * All methods degrade gracefully — network errors, timeouts, and invalid
 * responses return empty pages / null stats instead of throwing.
 */

import { z } from 'zod';
import type {
  ExternalSkillPage,
  ExternalSkillProvider,
  ExternalSkillStats,
  ExternalSkillSummary,
} from './ports/external-skill-provider.js';

/** Minimal logger contract compatible with pino, Fastify, and other structured loggers. */
export interface ProviderLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
}

// ── Zod schemas ─────────────────────────────────────────────────────────

// Self-hosted @mastra/skills-api response (browse)
const MastraSkillSchema = z.object({
  source: z.string(),
  skillId: z.string(),
  name: z.string(),
  installs: z.number(),
  owner: z.string(),
  repo: z.string(),
  githubUrl: z.string().optional(),
  displayName: z.string().optional(),
}).passthrough();

const MastraPageResponseSchema = z.object({
  skills: z.array(MastraSkillSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number().optional(),
});

const StatsResponseSchema = z.object({
  totalSkills: z.number(),
  totalSources: z.number(),
  totalOwners: z.number(),
  scrapedAt: z.string().optional(),
  totalInstalls: z.number().optional(),
});

// Public skills.sh /api/search response
const SkillsShSkillSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  name: z.string(),
  installs: z.number(),
  source: z.string(),
}).passthrough();

const SkillsShSearchResponseSchema = z.object({
  skills: z.array(SkillsShSkillSchema),
  count: z.number(),
  query: z.string().optional(),
  searchType: z.string().optional(),
  searchVersion: z.string().optional(),
  duration_ms: z.number().optional(),
});

// ── Config type ─────────────────────────────────────────────────────────

export interface ExternalSkillProviderHttpConfig {
  /** Self-hosted @mastra/skills-api base URL (browse + stats). */
  baseUrl: string;
  /** Public skills.sh base URL (search). */
  searchApiBaseUrl: string;
  searchTimeoutMs: number;
  browseTimeoutMs: number;
  statsTimeoutMs: number;
}

// ── Stats cache ─────────────────────────────────────────────────────────

const STATS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface StatsCache {
  data: ExternalSkillStats;
  fetchedAt: number;
}

// ── Search result cache ─────────────────────────────────────────────────
// skills.sh /api/search has no pagination. We request up to 200 results
// (its max) and slice pages locally. Cache briefly to avoid re-fetching
// for adjacent pages of the same query.

const SEARCH_CACHE_TTL_MS = 60 * 1000; // 1 minute
const SKILLS_SH_MAX_LIMIT = 200;

interface SearchCache {
  query: string;
  results: ExternalSkillSummary[];
  fetchedAt: number;
}

// ── Mapping helpers ─────────────────────────────────────────────────────

type MastraSkill = z.infer<typeof MastraSkillSchema>;

function mapMastraToSummary(skill: MastraSkill): ExternalSkillSummary {
  return {
    ref: `${skill.owner}/${skill.repo}/${skill.skillId}`,
    skillId: skill.skillId,
    name: skill.displayName ?? skill.name,
    description: '',
    owner: skill.owner,
    repo: skill.repo,
    installs: skill.installs,
  };
}

type SkillsShSkill = z.infer<typeof SkillsShSkillSchema>;

function mapSkillsShToSummary(skill: SkillsShSkill): ExternalSkillSummary {
  // source is "owner/repo" — split it
  const slashIdx = skill.source.indexOf('/');
  const owner = slashIdx > 0 ? skill.source.slice(0, slashIdx) : skill.source;
  const repo = slashIdx > 0 ? skill.source.slice(slashIdx + 1) : '';

  return {
    ref: skill.id, // already "owner/repo/skillId"
    skillId: skill.skillId,
    name: skill.name,
    description: '',
    owner,
    repo,
    installs: skill.installs,
  };
}

// ── Empty page constant ─────────────────────────────────────────────────

function emptyPage(page: number, pageSize: number): ExternalSkillPage {
  return { results: [], totalCount: 0, page, pageSize };
}

// ── Implementation ──────────────────────────────────────────────────────

export class ExternalSkillProviderHttp implements ExternalSkillProvider {
  private readonly baseUrl: string;
  private readonly searchApiBaseUrl: string;
  private readonly searchTimeoutMs: number;
  private readonly browseTimeoutMs: number;
  private readonly statsTimeoutMs: number;
  private readonly log: ProviderLogger;
  private statsCache: StatsCache | null = null;
  private searchCache: SearchCache | null = null;

  constructor(config: ExternalSkillProviderHttpConfig, logger: ProviderLogger) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.searchApiBaseUrl = config.searchApiBaseUrl.replace(/\/+$/, '');
    this.searchTimeoutMs = config.searchTimeoutMs;
    this.browseTimeoutMs = config.browseTimeoutMs;
    this.statsTimeoutMs = config.statsTimeoutMs;
    this.log = logger;
  }

  /**
   * Search via the public skills.sh /api/search endpoint (600k+ skills).
   *
   * skills.sh has no server-side pagination. We fetch up to 200 results
   * (the API max), cache them briefly, and slice the requested page locally.
   *
   * Falls back to the self-hosted @mastra/skills-api (34k+ skills) when
   * skills.sh is unavailable (429, timeout, network error). The fallback
   * uses the `query` parameter on the `/api/skills` endpoint.
   */
  async search(
    query: string,
    opts: { page: number; pageSize: number },
  ): Promise<ExternalSkillPage> {
    let results: ExternalSkillSummary[];
    try {
      results = await this.fetchSkillsShSearch(query);
    } catch (e) {
      // skills.sh failed and no stale cache — fall back to self-hosted Mastra API.
      const reason = e instanceof Error ? e.message : String(e);
      this.log.warn({ query, reason }, 'skills.sh search failed, falling back to self-hosted skills-api');
      return this.fetchMastraSearch(query, opts.page, opts.pageSize);
    }

    if (results.length === 0) {
      return emptyPage(opts.page, opts.pageSize);
    }

    const offset = (opts.page - 1) * opts.pageSize;
    const slice = results.slice(offset, offset + opts.pageSize);

    return {
      results: slice,
      // We know at least this many matched. The true total may be higher
      // but skills.sh caps at 200 results with no total count field.
      totalCount: results.length,
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }

  /**
   * Browse via the self-hosted @mastra/skills-api (34k+ skills, paginated).
   */
  async browse(opts: { page: number; pageSize: number }): Promise<ExternalSkillPage> {
    const url = new URL(`${this.baseUrl}/api/skills`);
    url.searchParams.set('sortBy', 'installs');
    url.searchParams.set('sortOrder', 'desc');
    url.searchParams.set('page', String(opts.page));
    url.searchParams.set('pageSize', String(opts.pageSize));

    return this.fetchMastraPage(url, this.browseTimeoutMs, opts.page, opts.pageSize);
  }

  /**
   * Stats from the self-hosted @mastra/skills-api. Cached for 5 minutes.
   */
  async getStats(): Promise<ExternalSkillStats | null> {
    const now = Date.now();
    if (this.statsCache && now - this.statsCache.fetchedAt < STATS_CACHE_TTL_MS) {
      return this.statsCache.data;
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/skills/stats`, {
        signal: AbortSignal.timeout(this.statsTimeoutMs),
      });

      if (!res.ok) {
        this.log.warn({ status: res.status }, 'external skills stats returned non-2xx');
        return this.statsCache?.data ?? null;
      }

      const body: unknown = await res.json();
      const parsed = StatsResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.log.warn({ issues: parsed.error.issues }, 'external skills stats response validation failed');
        return this.statsCache?.data ?? null;
      }

      const stats: ExternalSkillStats = {
        totalSkills: parsed.data.totalSkills,
        totalSources: parsed.data.totalSources,
        totalOwners: parsed.data.totalOwners,
      };

      this.statsCache = { data: stats, fetchedAt: Date.now() };
      return stats;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn({ err: msg }, 'external skills stats fetch failed');
      return this.statsCache?.data ?? null;
    }
  }

  // ── Private: skills.sh search ─────────────────────────────────────

  private async fetchSkillsShSearch(query: string): Promise<ExternalSkillSummary[]> {
    const now = Date.now();
    if (
      this.searchCache
      && this.searchCache.query === query
      && now - this.searchCache.fetchedAt < SEARCH_CACHE_TTL_MS
    ) {
      return this.searchCache.results;
    }

    try {
      const url = new URL(`${this.searchApiBaseUrl}/api/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', String(SKILLS_SH_MAX_LIMIT));

      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.searchTimeoutMs),
      });

      if (!res.ok) {
        const msg = `skills.sh search returned ${res.status}`;
        this.log.warn({ status: res.status }, msg);
        throw new Error(msg);
      }

      const body: unknown = await res.json();
      const parsed = SkillsShSearchResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.log.warn({ issues: parsed.error.issues }, 'skills.sh search response validation failed');
        throw new Error('skills.sh search response validation failed');
      }

      const results = parsed.data.skills.map(mapSkillsShToSummary);
      this.searchCache = { query, results, fetchedAt: Date.now() };
      return results;
    } catch (e) {
      // Return stale cache for the same query if available
      if (this.searchCache?.query === query) {
        return this.searchCache.results;
      }
      // Re-throw so callers (API route, worker tool) can handle appropriately
      throw e;
    }
  }

  // ── Private: @mastra/skills-api browse ────────────────────────────

  /**
   * Search fallback via the self-hosted @mastra/skills-api `query` parameter.
   * Smaller catalog (34k vs 600k) but fully self-hosted — no third-party rate limits.
   */
  private async fetchMastraSearch(
    query: string,
    page: number,
    pageSize: number,
  ): Promise<ExternalSkillPage> {
    const url = new URL(`${this.baseUrl}/api/skills`);
    url.searchParams.set('query', query);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));

    return this.fetchMastraPage(url, this.searchTimeoutMs, page, pageSize);
  }

  private async fetchMastraPage(
    url: URL,
    timeoutMs: number,
    page: number,
    pageSize: number,
  ): Promise<ExternalSkillPage> {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        this.log.warn({ status: res.status, url: url.pathname }, 'external skills API returned non-2xx');
        return emptyPage(page, pageSize);
      }

      const body: unknown = await res.json();
      const parsed = MastraPageResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.log.warn({ issues: parsed.error.issues, url: url.pathname }, 'external skills response validation failed');
        return emptyPage(page, pageSize);
      }

      return {
        results: parsed.data.skills.map(mapMastraToSummary),
        totalCount: parsed.data.total,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn({ err: msg, url: url.pathname }, 'external skills fetch failed');
      return emptyPage(page, pageSize);
    }
  }
}

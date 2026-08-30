/**
 * HTTP-based ExternalSkillProvider implementation.
 *
 * Calls a self-hosted @mastra/skills-api instance for external skill
 * discovery. All methods degrade gracefully — network errors, timeouts,
 * and invalid responses return empty pages / null stats instead of throwing.
 */

import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type {
  ExternalSkillPage,
  ExternalSkillProvider,
  ExternalSkillStats,
  ExternalSkillSummary,
} from '@herobids/domain';

// ── Zod schemas for @mastra/skills-api response validation ──────────────

const RegistrySkillSchema = z.object({
  source: z.string(),
  skillId: z.string(),
  name: z.string(),
  installs: z.number(),
  owner: z.string(),
  repo: z.string(),
  githubUrl: z.string().optional(),
  displayName: z.string().optional(),
}).passthrough();

const SkillsPageResponseSchema = z.object({
  skills: z.array(RegistrySkillSchema),
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

// ── Config type ─────────────────────────────────────────────────────────

export interface ExternalSkillProviderHttpConfig {
  baseUrl: string;
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

// ── Mapping helper ──────────────────────────────────────────────────────

type RegistrySkill = z.infer<typeof RegistrySkillSchema>;

function mapToSummary(skill: RegistrySkill): ExternalSkillSummary {
  return {
    ref: `${skill.owner}/${skill.repo}/${skill.skillId}`,
    skillId: skill.skillId,
    name: skill.displayName ?? skill.name,
    description: '', // skills-api does not provide a description field
    owner: skill.owner,
    repo: skill.repo,
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
  private readonly searchTimeoutMs: number;
  private readonly browseTimeoutMs: number;
  private readonly statsTimeoutMs: number;
  private readonly log: FastifyBaseLogger;
  private statsCache: StatsCache | null = null;

  constructor(config: ExternalSkillProviderHttpConfig, logger: FastifyBaseLogger) {
    // Strip trailing slash so path concatenation is clean
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.searchTimeoutMs = config.searchTimeoutMs;
    this.browseTimeoutMs = config.browseTimeoutMs;
    this.statsTimeoutMs = config.statsTimeoutMs;
    this.log = logger;
  }

  async search(
    query: string,
    opts: { page: number; pageSize: number },
  ): Promise<ExternalSkillPage> {
    const url = new URL(`${this.baseUrl}/api/skills`);
    url.searchParams.set('query', query);
    url.searchParams.set('page', String(opts.page));
    url.searchParams.set('pageSize', String(opts.pageSize));

    return this.fetchSkillsPage(url, this.searchTimeoutMs, opts.page, opts.pageSize);
  }

  async browse(opts: { page: number; pageSize: number }): Promise<ExternalSkillPage> {
    const url = new URL(`${this.baseUrl}/api/skills`);
    url.searchParams.set('sortBy', 'installs');
    url.searchParams.set('sortOrder', 'desc');
    url.searchParams.set('page', String(opts.page));
    url.searchParams.set('pageSize', String(opts.pageSize));

    return this.fetchSkillsPage(url, this.browseTimeoutMs, opts.page, opts.pageSize);
  }

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

  // ── Private helpers ─────────────────────────────────────────────────

  private async fetchSkillsPage(
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
      const parsed = SkillsPageResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.log.warn({ issues: parsed.error.issues, url: url.pathname }, 'external skills response validation failed');
        return emptyPage(page, pageSize);
      }

      return {
        results: parsed.data.skills.map(mapToSummary),
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

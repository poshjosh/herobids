import { describe, expect, it } from 'vitest';
import type { SourceKind } from '../skills.js';
import type { PaginatedResponse } from '../pagination.js';
import type {
  ExternalSkillSummary,
  ExternalSkillPage,
  ExternalSkillStats,
  ExternalSkillProvider,
} from '../ports/external-skill-provider.js';

/**
 * These tests verify that the new types introduced by the unified skill catalog
 * feature are correctly exported and usable. Since they are pure type definitions,
 * the tests use compile-time type assertions combined with runtime value checks.
 */

describe('SourceKind', () => {
  it('is exported and assignable to all three literal values', () => {
    // Compile-time type assertions — if SourceKind changes, these assignments
    // will fail at tsc time, which is the appropriate validation layer for
    // a pure type alias. The runtime check just confirms the import resolved.
    const system: SourceKind = 'system';
    const user: SourceKind = 'user';
    const external: SourceKind = 'external';
    expect([system, user, external]).toHaveLength(3);
  });
});

describe('PaginatedResponse', () => {
  it('is structurally valid with required fields', () => {
    const response: PaginatedResponse<string> = {
      items: ['a', 'b'],
      totalCount: 10,
      page: 1,
      pageSize: 2,
    };
    expect(response.items).toHaveLength(2);
    expect(response.totalCount).toBe(10);
    expect(response.page).toBe(1);
    expect(response.pageSize).toBe(2);
  });

  it('works with complex item types', () => {
    const response: PaginatedResponse<{ id: string; name: string }> = {
      items: [{ id: '1', name: 'test' }],
      totalCount: 1,
      page: 1,
      pageSize: 10,
    };
    expect(response.items[0]?.id).toBe('1');
  });

  it('works with an empty items array', () => {
    const response: PaginatedResponse<number> = {
      items: [],
      totalCount: 0,
      page: 1,
      pageSize: 10,
    };
    expect(response.items).toHaveLength(0);
  });
});

describe('ExternalSkillSummary', () => {
  it('is structurally valid with required fields', () => {
    const summary: ExternalSkillSummary = {
      ref: 'twostraws/swiftui-agent-skill/main',
      skillId: 'swiftui-agent-skill',
      name: 'SwiftUI Agent',
      description: 'A skill for SwiftUI development',
      owner: 'twostraws',
      repo: 'swiftui-agent-skill',
      installs: 42,
    };
    expect(summary.ref).toBe('twostraws/swiftui-agent-skill/main');
    expect(summary.installs).toBe(42);
    expect(summary.tags).toBeUndefined();
  });

  it('accepts optional tags field', () => {
    const summary: ExternalSkillSummary = {
      ref: 'owner/repo/skill',
      skillId: 'skill',
      name: 'Test Skill',
      description: 'desc',
      owner: 'owner',
      repo: 'repo',
      installs: 0,
      tags: ['swift', 'ios'],
    };
    expect(summary.tags).toEqual(['swift', 'ios']);
  });
});

describe('ExternalSkillPage', () => {
  it('is structurally valid with required fields', () => {
    const page: ExternalSkillPage = {
      results: [],
      totalCount: 0,
      page: 1,
      pageSize: 20,
    };
    expect(page.results).toHaveLength(0);
    expect(page.totalCount).toBe(0);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(20);
  });
});

describe('ExternalSkillStats', () => {
  it('is structurally valid with required fields', () => {
    const stats: ExternalSkillStats = {
      totalSkills: 100,
      totalSources: 5,
      totalOwners: 30,
    };
    expect(stats.totalSkills).toBe(100);
    expect(stats.totalSources).toBe(5);
    expect(stats.totalOwners).toBe(30);
  });
});

describe('ExternalSkillProvider', () => {
  it('can be implemented as a mock satisfying the interface', async () => {
    const mockProvider: ExternalSkillProvider = {
      search: async (_query, _opts) => ({
        results: [],
        totalCount: 0,
        page: 1,
        pageSize: 20,
      }),
      browse: async (_opts) => ({
        results: [],
        totalCount: 0,
        page: 1,
        pageSize: 20,
      }),
      getStats: async () => ({
        totalSkills: 50,
        totalSources: 3,
        totalOwners: 20,
      }),
    };

    const searchResult = await mockProvider.search('test', { page: 1, pageSize: 20 });
    expect(searchResult.totalCount).toBe(0);

    const browseResult = await mockProvider.browse({ page: 1, pageSize: 20 });
    expect(browseResult.results).toHaveLength(0);

    const stats = await mockProvider.getStats();
    expect(stats?.totalSkills).toBe(50);
  });

  it('getStats can return null', async () => {
    const mockProvider: ExternalSkillProvider = {
      search: async () => ({ results: [], totalCount: 0, page: 1, pageSize: 20 }),
      browse: async () => ({ results: [], totalCount: 0, page: 1, pageSize: 20 }),
      getStats: async () => null,
    };

    const stats = await mockProvider.getStats();
    expect(stats).toBeNull();
  });
});

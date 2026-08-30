import { describe, expect, it } from 'vitest';
import type { Skill } from '../../lib/api-client.js';
import { listSelectableSkills } from './agent-display.js';

/** Minimal Skill stub — only the fields that listSelectableSkills inspects. */
function makeSkill(overrides: Partial<Skill> & Pick<Skill, 'id' | 'name' | 'sourceKind'>): Skill {
  return {
    slug: overrides.id,
    authorId: null,
    publicationStatus: 'published',
    hasStagedRevision: false,
    priceCents: 0,
    likeCount: 0,
    forkCount: 0,
    popularityScore: 0,
    trendingScore: 0,
    isLikedByViewer: false,
    isSelectable: true,
    selectabilityReason: 'ok',
    currentRevisionId: null,
    currentRevisionVersion: null,
    description: '',
    instructions: '',
    promptHint: null,
    promptTemplate: null,
    requiredTools: [],
    contextRequirements: [],
    requiredGuardrails: [],
    capabilityFamilies: [],
    suggestedTickIntervalMs: null,
    tags: [],
    dependsOn: [],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('listSelectableSkills', () => {
  it('filters out the base skill by id', () => {
    const skills = [
      makeSkill({ id: 'base', name: 'Base', sourceKind: 'system' }),
      makeSkill({ id: 'trading', name: 'Trading', sourceKind: 'system' }),
    ];

    const result = listSelectableSkills(skills);
    expect(result.map((s) => s.id)).toEqual(['trading']);
  });

  it('filters out non-selectable skills', () => {
    const skills = [
      makeSkill({ id: 'trading', name: 'Trading', sourceKind: 'system' }),
      makeSkill({ id: 'unlisted', name: 'Unlisted', sourceKind: 'user', isSelectable: false }),
    ];

    const result = listSelectableSkills(skills);
    expect(result.map((s) => s.id)).toEqual(['trading']);
  });

  it('sorts system before user before external', () => {
    const skills = [
      makeSkill({ id: 'ext-1', name: 'Alpha Plugin', sourceKind: 'external' }),
      makeSkill({ id: 'user-1', name: 'My Custom', sourceKind: 'user' }),
      makeSkill({ id: 'sys-1', name: 'Trading', sourceKind: 'system' }),
    ];

    const result = listSelectableSkills(skills);
    expect(result.map((s) => s.sourceKind)).toEqual(['system', 'user', 'external']);
  });

  it('sorts by publication status within the same sourceKind', () => {
    const skills = [
      makeSkill({ id: 'draft-1', name: 'Draft Skill', sourceKind: 'user', publicationStatus: 'draft' }),
      makeSkill({ id: 'pub-1', name: 'Published Skill', sourceKind: 'user', publicationStatus: 'published' }),
      makeSkill({ id: 'priv-1', name: 'Private Skill', sourceKind: 'user', publicationStatus: 'private' }),
    ];

    const result = listSelectableSkills(skills);
    expect(result.map((s) => s.publicationStatus)).toEqual(['published', 'private', 'draft']);
  });

  it('sorts alphabetically by name within the same sourceKind and status', () => {
    const skills = [
      makeSkill({ id: 'z', name: 'Zebra', sourceKind: 'system' }),
      makeSkill({ id: 'a', name: 'Alpha', sourceKind: 'system' }),
      makeSkill({ id: 'm', name: 'Mango', sourceKind: 'system' }),
    ];

    const result = listSelectableSkills(skills);
    expect(result.map((s) => s.name)).toEqual(['Alpha', 'Mango', 'Zebra']);
  });

  it('falls back to id comparison when name and all other fields match', () => {
    const skills = [
      makeSkill({ id: 'z-dup', name: 'Same', sourceKind: 'user' }),
      makeSkill({ id: 'a-dup', name: 'Same', sourceKind: 'user' }),
    ];

    const result = listSelectableSkills(skills);
    expect(result.map((s) => s.id)).toEqual(['a-dup', 'z-dup']);
  });

  it('applies the full sort order: system → user → external, then status, then name', () => {
    const skills = [
      makeSkill({ id: 'ext-zap', name: 'Zap', sourceKind: 'external' }),
      makeSkill({ id: 'user-beta', name: 'Beta', sourceKind: 'user', publicationStatus: 'private' }),
      makeSkill({ id: 'sys-gamma', name: 'Gamma', sourceKind: 'system' }),
      makeSkill({ id: 'ext-alpha', name: 'Alpha', sourceKind: 'external' }),
      makeSkill({ id: 'sys-alpha', name: 'Alpha', sourceKind: 'system' }),
      makeSkill({ id: 'user-alpha', name: 'Alpha', sourceKind: 'user', publicationStatus: 'published' }),
    ];

    const result = listSelectableSkills(skills);
    expect(result.map((s) => s.id)).toEqual([
      'sys-alpha',     // system, published, Alpha
      'sys-gamma',     // system, published, Gamma
      'user-alpha',    // user, published, Alpha
      'user-beta',     // user, private, Beta
      'ext-alpha',     // external, published, Alpha
      'ext-zap',       // external, published, Zap
    ]);
  });

  it('returns an empty array when no skills pass the filter', () => {
    const skills = [
      makeSkill({ id: 'base', name: 'Base', sourceKind: 'system' }),
      makeSkill({ id: 'hidden', name: 'Hidden', sourceKind: 'user', isSelectable: false }),
    ];

    const result = listSelectableSkills(skills);
    expect(result).toEqual([]);
  });

  it('returns an empty array for empty input', () => {
    expect(listSelectableSkills([])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const skills = [
      makeSkill({ id: 'b', name: 'Bravo', sourceKind: 'user' }),
      makeSkill({ id: 'a', name: 'Alpha', sourceKind: 'system' }),
    ];
    const originalOrder = skills.map((s) => s.id);

    listSelectableSkills(skills);

    expect(skills.map((s) => s.id)).toEqual(originalOrder);
  });
});

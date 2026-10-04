import { describe, it, expect } from 'vitest';
import {
  classifySkillRef,
  partitionSkillRefs,
} from '../skill-resolution.js';

// ── classifySkillRef ────────────────────────────────────────────────────────

describe('classifySkillRef', () => {
  it.each([
    ['system/programming', { kind: 'slug', slug: 'system/programming' }],
    ['alice/my-skill', { kind: 'slug', slug: 'alice/my-skill' }],
    [
      'twostraws/swiftui-agent-skill',
      { kind: 'slug', slug: 'twostraws/swiftui-agent-skill' },
    ],
  ])('classifies slug ref: %s', (ref, expected) => {
    expect(classifySkillRef(ref)).toEqual(expected);
  });

  it.each([
    ['programming', { kind: 'legacy-id', id: 'programming' }],
    ['web-access', { kind: 'legacy-id', id: 'web-access' }],
  ])('classifies legacy ID ref: %s', (ref, expected) => {
    expect(classifySkillRef(ref)).toEqual(expected);
  });

  it('treats empty string as legacy ID', () => {
    expect(classifySkillRef('')).toEqual({ kind: 'legacy-id', id: '' });
  });

  it('classifies ref with multiple slashes as slug', () => {
    expect(classifySkillRef('a/b/c')).toEqual({ kind: 'slug', slug: 'a/b/c' });
  });

  it('does not trim whitespace (caller responsibility)', () => {
    expect(classifySkillRef(' programming ')).toEqual({ kind: 'legacy-id', id: ' programming ' });
    expect(classifySkillRef(' system/programming ')).toEqual({ kind: 'slug', slug: ' system/programming ' });
  });
});

// ── partitionSkillRefs ──────────────────────────────────────────────────────

describe('partitionSkillRefs', () => {
  it('returns empty buckets for empty input', () => {
    expect(partitionSkillRefs([])).toEqual({ slugLike: [], legacyIds: [] });
  });

  it('puts all slug-like refs into slugLike', () => {
    const refs = ['system/programming', 'alice/my-skill'];
    expect(partitionSkillRefs(refs)).toEqual({
      slugLike: ['system/programming', 'alice/my-skill'],
      legacyIds: [],
    });
  });

  it('puts all legacy refs into legacyIds', () => {
    const refs = ['programming', 'web-access'];
    expect(partitionSkillRefs(refs)).toEqual({
      slugLike: [],
      legacyIds: ['programming', 'web-access'],
    });
  });

  it('partitions mixed refs into correct buckets', () => {
    const refs = ['programming', 'system/programming', 'web-access', 'alice/my-skill'];
    expect(partitionSkillRefs(refs)).toEqual({
      slugLike: ['system/programming', 'alice/my-skill'],
      legacyIds: ['programming', 'web-access'],
    });
  });

  it('preserves input order within each bucket', () => {
    const refs = [
      'alice/z-skill',
      'z-legacy',
      'bob/a-skill',
      'a-legacy',
      'alice/m-skill',
    ];
    const result = partitionSkillRefs(refs);
    expect(result.slugLike).toEqual([
      'alice/z-skill',
      'bob/a-skill',
      'alice/m-skill',
    ]);
    expect(result.legacyIds).toEqual(['z-legacy', 'a-legacy']);
  });

  it('does not deduplicate — duplicates appear in both buckets', () => {
    const refs = ['programming', 'programming', 'system/programming', 'system/programming'];
    const result = partitionSkillRefs(refs);
    expect(result.legacyIds).toEqual(['programming', 'programming']);
    expect(result.slugLike).toEqual(['system/programming', 'system/programming']);
  });
});

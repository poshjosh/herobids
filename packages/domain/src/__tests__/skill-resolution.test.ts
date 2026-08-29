import { describe, it, expect } from 'vitest';
import {
  classifySkillRef,
  partitionSkillRefs,
} from '../skill-resolution.js';

// ── classifySkillRef ────────────────────────────────────────────────────────

describe('classifySkillRef', () => {
  it.each([
    ['system/trading', { kind: 'slug', slug: 'system/trading' }],
    ['alice/my-skill', { kind: 'slug', slug: 'alice/my-skill' }],
    [
      'twostraws/swiftui-agent-skill',
      { kind: 'slug', slug: 'twostraws/swiftui-agent-skill' },
    ],
  ])('classifies slug ref: %s', (ref, expected) => {
    expect(classifySkillRef(ref)).toEqual(expected);
  });

  it.each([
    ['trading', { kind: 'legacy-id', id: 'trading' }],
    ['bot-management', { kind: 'legacy-id', id: 'bot-management' }],
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
    expect(classifySkillRef(' trading ')).toEqual({ kind: 'legacy-id', id: ' trading ' });
    expect(classifySkillRef(' system/trading ')).toEqual({ kind: 'slug', slug: ' system/trading ' });
  });
});

// ── partitionSkillRefs ──────────────────────────────────────────────────────

describe('partitionSkillRefs', () => {
  it('returns empty buckets for empty input', () => {
    expect(partitionSkillRefs([])).toEqual({ slugLike: [], legacyIds: [] });
  });

  it('puts all slug-like refs into slugLike', () => {
    const refs = ['system/trading', 'alice/my-skill'];
    expect(partitionSkillRefs(refs)).toEqual({
      slugLike: ['system/trading', 'alice/my-skill'],
      legacyIds: [],
    });
  });

  it('puts all legacy refs into legacyIds', () => {
    const refs = ['trading', 'bot-management'];
    expect(partitionSkillRefs(refs)).toEqual({
      slugLike: [],
      legacyIds: ['trading', 'bot-management'],
    });
  });

  it('partitions mixed refs into correct buckets', () => {
    const refs = ['trading', 'system/trading', 'bot-management', 'alice/my-skill'];
    expect(partitionSkillRefs(refs)).toEqual({
      slugLike: ['system/trading', 'alice/my-skill'],
      legacyIds: ['trading', 'bot-management'],
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
    const refs = ['trading', 'trading', 'system/trading', 'system/trading'];
    const result = partitionSkillRefs(refs);
    expect(result.legacyIds).toEqual(['trading', 'trading']);
    expect(result.slugLike).toEqual(['system/trading', 'system/trading']);
  });
});

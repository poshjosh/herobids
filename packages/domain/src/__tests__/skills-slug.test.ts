import { describe, it, expect } from 'vitest';
import {
  slugify,
  buildSkillSlug,
  SYSTEM_SKILL_SLUGS,
  SYSTEM_SKILLS,
  BASE_SKILL,
} from '../skills.js';

// ── slugify ─────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it.each([
    ['Bot Management', 'bot-management'],
    ['Web Access', 'web-access'],
  ])('converts normal names: %s → %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('converts a single word', () => {
    expect(slugify('Trading')).toBe('trading');
  });

  it('passes through already kebab-case input', () => {
    expect(slugify('bot-management')).toBe('bot-management');
  });

  it('collapses double/multiple spaces', () => {
    expect(slugify('Bot  Management')).toBe('bot-management');
  });

  it('trims leading and trailing spaces', () => {
    expect(slugify('  Trading  ')).toBe('trading');
  });

  it('strips non-alphanumeric characters', () => {
    expect(slugify('My Skill (v2)')).toBe('my-skill-v2');
  });

  it('collapses mixed hyphens and spaces', () => {
    expect(slugify('Web - Access')).toBe('web-access');
  });

  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('');
  });

  it.each([
    ['   ', '', 'whitespace-only'],
    ['---', '', 'all-hyphens'],
    ['123', '123', 'numeric-only'],
    ['hello_world', 'hello-world', 'underscores become hyphens'],
    ['!@#', '', 'all-special-characters'],
  ])('edge case: %s → %s (%s)', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

// ── buildSkillSlug ──────────────────────────────────────────────────────────

describe('buildSkillSlug', () => {
  it.each([
    ['system', 'Trading', 'system/trading'],
    ['system', 'Bot Management', 'system/bot-management'],
    ['alice', 'My Custom Strategy', 'alice/my-custom-strategy'],
    ['alice', '  My Skill (v2)  ', 'alice/my-skill-v2'],
  ])('buildSkillSlug(%s, %s) → %s', (author, name, expected) => {
    expect(buildSkillSlug(author, name)).toBe(expected);
  });

  it('does not slugify the authorHandle (pass-through)', () => {
    expect(buildSkillSlug('Alice', 'Trading')).toBe('alice/trading');
  });

  it('produces trailing slash for empty name', () => {
    expect(buildSkillSlug('system', '')).toBe('system/');
  });

  it('produces trailing slash for whitespace-only name', () => {
    expect(buildSkillSlug('system', '   ')).toBe('system/');
  });
});

// ── SYSTEM_SKILL_SLUGS ─────────────────────────────────────────────────────

describe('SYSTEM_SKILL_SLUGS', () => {
  it('has exactly as many entries as SYSTEM_SKILLS', () => {
    expect(SYSTEM_SKILL_SLUGS.size).toBe(SYSTEM_SKILLS.length);
  });

  it.each([
    ['system/trading', 'trading'],
    ['system/bot-management', 'bot-management'],
    ['system/programming', 'programming'],
  ])('maps %s → %s', (slug, id) => {
    expect(SYSTEM_SKILL_SLUGS.get(slug)).toBe(id);
  });

  it('all entries follow the system/<id> pattern', () => {
    for (const [slug, id] of SYSTEM_SKILL_SLUGS) {
      expect(slug).toBe(`system/${id}`);
    }
  });
});

// ── SkillDefinition.slug on system skills ───────────────────────────────────

describe('SkillDefinition.slug', () => {
  it('all SYSTEM_SKILLS entries have a non-undefined slug', () => {
    for (const skill of SYSTEM_SKILLS) {
      expect(skill.slug).toBeDefined();
    }
  });

  it('BASE_SKILL has slug system/base', () => {
    expect(BASE_SKILL.slug).toBe('system/base');
  });

  it('every system skill slug matches system/<id>', () => {
    for (const skill of SYSTEM_SKILLS) {
      expect(skill.slug).toBe(`system/${skill.id}`);
    }
  });
});

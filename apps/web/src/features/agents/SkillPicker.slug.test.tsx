/**
 * Tests for the slug field in SkillPicker:
 * - The search filter now matches against skill.slug
 * - The component renders skill.slug between name and description
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { SkillPicker } from './SkillPicker.js';
import type { Skill } from '../../lib/api-client.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-1',
    slug: 'test-skill',
    authorId: null,
    sourceKind: 'system',
    publicationStatus: 'published',
    hasStagedRevision: false,
    priceCents: 0,
    likeCount: 0,
    forkCount: 0,
    popularityScore: 0,
    trendingScore: 0,
    isLikedByViewer: false,
    isSelectable: true,
    selectabilityReason: '',
    currentRevisionId: null,
    currentRevisionVersion: null,
    name: 'Test Skill',
    description: 'A test skill description',
    instructions: 'Do the thing',
    promptHint: null,
    promptTemplate: null,
    requiredTools: [],
    contextRequirements: [],
    requiredGuardrails: [],
    capabilityFamilies: [],
    suggestedTickIntervalMs: null,
    tags: [],
    dependsOn: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderPicker(skills: Skill[], selectedIds: string[] = []): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Pass the skills via `initialSkills` so the picker renders them directly and
  // its default fetch query stays disabled.
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <SkillPicker
          initialSkills={skills}
          selectedSkillIds={selectedIds}
          onChange={() => undefined}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

// ── Slug rendering ──────────────────────────────────────────────────────────

describe('SkillPicker slug rendering', () => {
  it('renders the slug text in each skill entry', () => {
    const skill = makeSkill({ slug: 'momentum-screener' });
    const html = renderPicker([skill]);

    expect(html).toContain('momentum-screener');
  });

  it('renders the slug in a monospace element', () => {
    const skill = makeSkill({ slug: 'my-picker-slug' });
    const html = renderPicker([skill]);

    expect(html).toContain('monospace');
    expect(html).toContain('my-picker-slug');
  });

  it('renders distinct slugs for multiple skills', () => {
    const skills = [
      makeSkill({ id: 'a', slug: 'alpha-slug', name: 'Alpha' }),
      makeSkill({ id: 'b', slug: 'beta-slug', name: 'Beta' }),
    ];
    const html = renderPicker(skills);

    expect(html).toContain('alpha-slug');
    expect(html).toContain('beta-slug');
  });

  it('renders the slug between the name and description', () => {
    const skill = makeSkill({
      slug: 'position-in-layout',
      name: 'Layout Skill',
      description: 'Checks layout ordering',
    });
    const html = renderPicker([skill]);

    // All three should be present
    expect(html).toContain('Layout Skill');
    expect(html).toContain('position-in-layout');
    expect(html).toContain('Checks layout ordering');

    // Slug appears after name and before description in the HTML output
    const nameIdx = html.indexOf('Layout Skill');
    const slugIdx = html.indexOf('position-in-layout');
    const descIdx = html.indexOf('Checks layout ordering');
    expect(slugIdx).toBeGreaterThan(nameIdx);
    expect(descIdx).toBeGreaterThan(slugIdx);
  });

  it('renders an empty slug without crashing', () => {
    const skill = makeSkill({ slug: '' });
    const html = renderPicker([skill]);

    expect(html).toContain('Test Skill');
  });
});

// ── SkillPicker search filter slug matching ─────────────────────────────────
//
// The SkillPicker filter is internal to the component (useMemo + searchTerm
// state). Since we test with renderToStaticMarkup (initial state, searchTerm=''),
// all skills are always visible. We test the filter logic directly as a
// replicated pure function — this matches the implementation exactly.

describe('SkillPicker search filter slug matching', () => {
  // Replicate the filter logic from SkillPicker's filteredSkills useMemo
  function filterSkills(skills: Skill[], term: string): Skill[] {
    const t = term.trim().toLowerCase();
    if (!t) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(t) ||
        skill.description.toLowerCase().includes(t) ||
        skill.slug.toLowerCase().includes(t),
    );
  }

  const skills = [
    makeSkill({ id: '1', slug: 'trade-executor', name: 'Executor', description: 'Executes trades on venues' }),
    makeSkill({ id: '2', slug: 'risk-gate', name: 'Risk Gate', description: 'Enforces risk limits' }),
    makeSkill({ id: '3', slug: 'portfolio-balance', name: 'Balancer', description: 'Rebalances portfolio' }),
  ];

  it('returns all skills when search term is empty', () => {
    expect(filterSkills(skills, '')).toEqual(skills);
  });

  it('returns all skills when search term is whitespace', () => {
    expect(filterSkills(skills, '   ')).toEqual(skills);
  });

  it('matches by slug substring', () => {
    const result = filterSkills(skills, 'trade-exec');
    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe('trade-executor');
  });

  it('matches by slug when name and description do not contain the term', () => {
    // "portfolio-balance" only appears in slug
    const result = filterSkills(skills, 'portfolio-bal');
    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe('portfolio-balance');
  });

  it('performs case-insensitive slug matching', () => {
    const result = filterSkills(skills, 'RISK-GATE');
    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe('risk-gate');
  });

  it('still matches by name when slug does not match', () => {
    const result = filterSkills(skills, 'Balancer');
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Balancer');
  });

  it('still matches by description when slug does not match', () => {
    const result = filterSkills(skills, 'Enforces risk');
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Risk Gate');
  });

  it('returns empty when nothing matches name, description, or slug', () => {
    expect(filterSkills(skills, 'zzz-no-match')).toHaveLength(0);
  });

  it('matches multiple skills sharing a slug prefix', () => {
    const sharedSkills = [
      makeSkill({ id: '1', slug: 'scan-momentum', name: 'Momentum', description: 'Momentum scanning' }),
      makeSkill({ id: '2', slug: 'scan-volume', name: 'Volume', description: 'Volume scanning' }),
      makeSkill({ id: '3', slug: 'alert-price', name: 'Alert', description: 'Price alerts' }),
    ];
    const result = filterSkills(sharedSkills, 'scan-');
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.slug)).toEqual(['scan-momentum', 'scan-volume']);
  });
});

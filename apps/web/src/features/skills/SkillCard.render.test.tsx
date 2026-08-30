import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { messages } from '../../app/i18n/locales/en.js';
import { SkillsPage } from './SkillsPage.js';
import type { Skill } from '../../lib/api-client.js';

// SkillsPage calls useSession() — mock it to return a minimal session so
// renderToStaticMarkup works without a full provider tree.
vi.mock('../../app/providers/SessionProvider.js', () => ({
  useSession: () => ({
    login: vi.fn().mockResolvedValue(undefined),
    user: null,
    loading: false,
    authenticated: false,
    logout: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
  SessionProvider: ({ children }: { children: ReactNode }) => children,
}));

/** Build a minimal Skill object with sensible defaults; any field can be overridden. */
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

/**
 * Render the SkillsPage with pre-populated query data so SkillCard instances
 * are rendered server-side. The selectable skills query controls what appears
 * in the "All" / "Built-in" tabs.
 */
function renderPage(skills: Skill[]): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  // SkillsPage issues paginated skill queries — seed all of them so rendering is synchronous.
  const paginatedSkills = { skills, totalCount: skills.length, page: 1, pageSize: 20 };
  const emptyPage = { skills: [], totalCount: 0, page: 1, pageSize: 20 };
  queryClient.setQueryData(['skills', 'selectable', 1], paginatedSkills);
  queryClient.setQueryData(['skills', 'mine'], emptyPage);
  queryClient.setQueryData(['skills', 'built-in'], emptyPage);
  queryClient.setQueryData(['skills', 'marketplace', 1], emptyPage);
  queryClient.setQueryData(['agent-tools'], { tools: [], categories: [] });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <SkillsPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('SkillCard dependency pills rendering', () => {
  it('does not render the dependency section when dependsOn is empty', () => {
    const skill = makeSkill({ dependsOn: [] });
    const html = renderPage([skill]);

    // The skill name must be present (card rendered), but the dependency label must not.
    expect(html).toContain('Test Skill');
    expect(html).not.toContain(messages['skills.card.dependsOn']);
  });

  it('renders a "Depends on:" label and a pill for each dependency when dependsOn is non-empty', () => {
    const skill = makeSkill({
      dependsOn: ['risk_management', 'portfolio_tracker'],
    });
    const html = renderPage([skill]);

    expect(html).toContain('Test Skill');
    expect(html).toContain(messages['skills.card.dependsOn']);
    expect(html).toContain('risk_management');
    expect(html).toContain('portfolio_tracker');
  });

  it('renders dependency pills for each skill card independently', () => {
    const skillA = makeSkill({
      id: 'skill-a',
      name: 'Skill A',
      dependsOn: ['dep_alpha'],
    });
    const skillB = makeSkill({
      id: 'skill-b',
      name: 'Skill B',
      dependsOn: [],
    });
    const skillC = makeSkill({
      id: 'skill-c',
      name: 'Skill C',
      dependsOn: ['dep_beta', 'dep_gamma'],
    });
    const html = renderPage([skillA, skillB, skillC]);

    // Skill A shows its single dependency
    expect(html).toContain('Skill A');
    expect(html).toContain('dep_alpha');

    // Skill B renders without any dependency section
    expect(html).toContain('Skill B');

    // Skill C shows both dependencies
    expect(html).toContain('Skill C');
    expect(html).toContain('dep_beta');
    expect(html).toContain('dep_gamma');
  });

  it('renders a single dependency pill correctly', () => {
    const skill = makeSkill({
      dependsOn: ['only_dep'],
    });
    const html = renderPage([skill]);

    expect(html).toContain(messages['skills.card.dependsOn']);
    expect(html).toContain('only_dep');
  });
});

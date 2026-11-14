// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages as enMessages } from '../../app/i18n/locales/en.js';
import { messages as arMessages } from '../../app/i18n/locales/ar.js';
import { auth, blueprints, type BlueprintSummary } from '../../lib/api-client.js';
import { BlueprintBrowse } from './BlueprintBrowse.js';

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    auth: { ...actual.auth, me: vi.fn() },
    blueprints: { ...actual.blueprints, browse: vi.fn() },
  };
});

const BLUEPRINT = {
  id: 'bp-1',
  kind: 'agent',
  name: 'Job hunter',
  description: '',
  tags: [],
  likeCount: 3,
  forkCount: 2,
  isLikedByViewer: false,
  // The viewer is the author, so the card shows the like count instead of the like button.
  authorId: 'user-1',
  performanceScore: 0,
  strategyType: null,
  venueType: null,
  style: null,
} as unknown as BlueprintSummary;

function renderBrowse(locale: 'en' | 'ar', items: BlueprintSummary[] = [BLUEPRINT]) {
  vi.mocked(blueprints.browse).mockResolvedValue({ items, nextCursor: null } as never);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale={locale} messages={locale === 'ar' ? arMessages : enMessages}>
        <BlueprintBrowse defaultKind="agent" onUseBlueprint={() => undefined} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('BlueprintBrowse translations', () => {
  beforeEach(() => {
    vi.mocked(auth.me).mockResolvedValue({ id: 'user-1' } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the filters and card labels in the selected language', async () => {
    renderBrowse('ar');
    await screen.findByText('Job hunter');
    for (const id of ['marketplace.kind.all', 'marketplace.kind.agents', 'marketplace.kind.bots', 'marketplace.sort.popular', 'marketplace.sort.ranking']) {
      expect(screen.getByRole('button', { name: arMessages[id] })).toBeTruthy();
    }
    expect(screen.getByText(`🤖 ${arMessages['marketplace.card.kindAgent']}`)).toBeTruthy();
    expect(screen.getByText(arMessages['marketplace.card.noDescription']!)).toBeTruthy();
    expect(screen.getByText(arMessages['marketplace.card.likes']!)).toBeTruthy();
    expect(screen.getByText(arMessages['marketplace.card.copies']!)).toBeTruthy();
    expect(screen.getByRole('button', { name: arMessages['agents.marketplace.useAgent'] })).toBeTruthy();
    expect(screen.queryByText('Likes')).toBeNull();
  });

  it('shows the empty state in the selected language', async () => {
    renderBrowse('ar', []);
    expect(await screen.findByText(arMessages['marketplace.empty.title']!)).toBeTruthy();
    expect(screen.getByText(arMessages['marketplace.empty.message']!)).toBeTruthy();
  });

  it('keeps the English labels in English', async () => {
    renderBrowse('en');
    await screen.findByText('Job hunter');
    expect(screen.getByRole('button', { name: 'Popular' })).toBeTruthy();
    expect(screen.getByText('🤖 Agent')).toBeTruthy();
    expect(screen.getByText('Copies')).toBeTruthy();
  });
});

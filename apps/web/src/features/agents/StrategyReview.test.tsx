import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';

// ── Controllable query mock ─────────────────────────────────────────────

let mockReviewResults: unknown = { changes: [] };

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');
  return {
    ...(actual as Record<string, unknown>),
    useMutation: vi.fn(() => ({
      isPending: false,
      isError: false,
      isSuccess: false,
      error: null,
      data: null,
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      reset: vi.fn(),
    })),
    useQuery: vi.fn((opts: { queryKey?: unknown[] }) => {
      const key = opts?.queryKey ?? [];
      const isReviewResults = key.includes('platform-assessment-review') && key.includes('results');
      return {
        data: isReviewResults ? mockReviewResults : undefined,
        isLoading: false,
        isError: false,
        isSuccess: isReviewResults,
        refetch: vi.fn(),
      };
    }),
  };
});

// Mock dependencies
vi.mock('../../lib/api-client.js', () => ({
  agents: {
    platformAssessmentReviews: {
      eligibility: vi.fn().mockResolvedValue({ canTrigger: true, reason: null }),
      trigger: vi.fn(),
      getResults: vi.fn().mockResolvedValue({ changes: [] }),
    },
  },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

import { StrategyReview } from './StrategyReview.js';

function renderComponent(): string {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <QueryClientProvider client={queryClient}>
        <StrategyReview agentId="agent-1" />
      </QueryClientProvider>
    </IntlProvider>,
  );
}

describe('StrategyReview', () => {
  beforeEach(() => {
    mockReviewResults = { changes: [] };
  });

  it('renders the Run Strategy Review button', () => {
    const html = renderComponent();
    expect(html).toContain(messages['agents.strategyReview.runReview']);
  });

  it('shows the agent\'s chosen preset and reason', () => {
    mockReviewResults = {
      changes: [
        {
          id: 'c1',
          ownerId: 'owner-1',
          actorId: 'agent-1',
          fromStrategy: { presetKey: 'momentum' },
          toStrategy: { presetKey: 'range' },
          artifactId: 'a1',
          reason: 'Range fits the choppy regime',
          state: 'applied',
          createdAt: '2026-10-10T00:00:00.000Z',
          appliedAt: '2026-10-10T00:00:00.000Z',
        },
      ],
    };

    const html = renderComponent();
    expect(html).toContain('Range fits the choppy regime');
    expect(html).toContain('momentum');
    expect(html).toContain('range');
  });

  it('shows that the agent kept its current preset', () => {
    mockReviewResults = {
      changes: [
        {
          id: 'c1',
          ownerId: 'owner-1',
          actorId: 'agent-1',
          fromStrategy: { presetKey: 'momentum' },
          toStrategy: { presetKey: 'momentum' },
          artifactId: 'a1',
          reason: 'Current preset still fits',
          state: 'applied',
          createdAt: '2026-10-10T00:00:00.000Z',
          appliedAt: '2026-10-10T00:00:00.000Z',
        },
      ],
    };

    const html = renderComponent();
    expect(html).toContain(messages['agents.strategyReview.results.agentKept']!.replace('{preset}', 'momentum'));
  });
});
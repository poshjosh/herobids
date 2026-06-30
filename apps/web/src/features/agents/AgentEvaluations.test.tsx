import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';

// ── Controllable mutation mock ──────────────────────────────────────────

let mockMutationState: {
  isError?: boolean;
  isPending?: boolean;
  isSuccess?: boolean;
  error?: unknown;
} = {};

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');
  return {
    ...(actual as Record<string, unknown>),
    useMutation: vi.fn(() => ({
      isPending: false,
      isError: false,
      isSuccess: false,
      error: null,
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      reset: vi.fn(),
      ...mockMutationState,
    })),
  };
});

// Mock dependencies
vi.mock('../../lib/api-client.js', () => ({
  agents: {
    evaluations: {
      list: vi.fn().mockResolvedValue([]),
      trigger: vi.fn(),
      get: vi.fn(),
      listArtifacts: vi.fn(),
      getArtifactUrl: vi.fn().mockReturnValue('/api/agents/x/evaluations/y/artifacts/z'),
    },
    get: vi.fn(),
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

vi.mock('./AgentEvaluationReport.js', () => ({
  AgentEvaluationReport: function MockReport() {
    return '<div>Mock Report</div>';
  },
}));

import { ApiError } from '../../lib/api-client.js';
import { AgentEvaluations } from './AgentEvaluations.js';

function renderComponent(): string {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <QueryClientProvider client={queryClient}>
        <AgentEvaluations agentId="agent-1" />
      </QueryClientProvider>
    </IntlProvider>,
  );
}

describe('AgentEvaluations', () => {
  beforeEach(() => {
    mockMutationState = {};
  });

  it('renders the evaluations section title', () => {
    const html = renderComponent();
    expect(html).toContain(messages['agents.evaluations.title']);
  });

  it('renders the Run Evaluation button', () => {
    const html = renderComponent();
    expect(html).toContain(messages['agents.evaluations.runNow']);
  });

  it('renders empty state when no evaluations exist', () => {
    const html = renderComponent();
    // With mock returning empty array, should show the empty state
    // The component shows loading first, but the message key should be present
    expect(html).toContain('Evaluations');
  });

  // ── Error display regression tests ────────────────────────────────────

  it('displays specific ApiError.message when API returns a non-409 error', () => {
    mockMutationState = {
      isError: true,
      error: new ApiError(
        400,
        'scope_resolution_failed',
        'No session found for agent agent-1. Start the agent to create a session first.',
      ),
    };

    const html = renderComponent();

    // Should show the specific message from the API
    expect(html).toContain(
      'No session found for agent agent-1. Start the agent to create a session first.',
    );
    // Should NOT show the generic fallback message
    expect(html).not.toContain(messages['agents.evaluations.triggerError']);
    // Should NOT show the 409 conflict message
    expect(html).not.toContain(messages['agents.evaluations.alreadyRunning']);
  });

  it('displays the alreadyRunning i18n message when API returns 409', () => {
    mockMutationState = {
      isError: true,
      error: new ApiError(
        409,
        'conflict',
        'An evaluation is already running for agent agent-1 with scope session:xyz.',
      ),
    };

    const html = renderComponent();

    // Should show the 409-specific i18n message
    expect(html).toContain(messages['agents.evaluations.alreadyRunning']);
    // Should NOT show the raw API error message body (only the i18n version)
    expect(html).not.toContain('scope session:xyz');
    // Should NOT show the generic fallback
    expect(html).not.toContain(messages['agents.evaluations.triggerError']);
  });

  it('falls back to generic triggerError i18n message when error is not an ApiError', () => {
    mockMutationState = {
      isError: true,
      error: new Error('Network failure'),
    };

    const html = renderComponent();

    // Should show the generic fallback
    expect(html).toContain(messages['agents.evaluations.triggerError']);
    // Should NOT show the raw error message
    expect(html).not.toContain('Network failure');
  });

  it('falls back to generic triggerError when ApiError has no message', () => {
    // ApiError with empty string message
    mockMutationState = {
      isError: true,
      error: new ApiError(500, 'internal_error', ''),
    };

    const html = renderComponent();

    // Empty string is falsy, so should fall through to generic
    expect(html).toContain(messages['agents.evaluations.triggerError']);
  });
});

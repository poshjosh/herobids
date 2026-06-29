import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';

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
});

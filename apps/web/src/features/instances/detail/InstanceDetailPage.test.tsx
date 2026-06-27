/**
 * UI interaction tests for InstanceDetailPage lifecycle action buttons.
 *
 * Tests key rendering scenarios: which buttons are shown for each bot status,
 * error banner display, and loading state behavior.
 *
 * Renders the page with mocked hooks and verifies the HTML output.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Simple English messages fallback — matches react-intl IntlProvider requirement
const enMessages = {
  'status.running': 'Running',
  'status.stopped': 'Stopped',
  'status.crashed': 'Crashed',
  'status.starting': 'Starting',
};

// ── Mock Setup ──────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockRefetch = vi.fn();
const mockMutate = vi.fn();

// Default: bot not found / loading
let mockBotData: Record<string, unknown> | null = null;
let mockBotIsLoading = true;
let mockBotIsError = false;
let mockBotError: Error | null = null;
let mockPositions: Array<Record<string, unknown>> = [];
let mockPositionsIsLoading = false;
let mockJournalEvents: Array<Record<string, unknown>> = [];
let mockJournalIsLoading = false;

// Per-mutation pending states — called in stop, start, delete order
let mockStopPending = false;
let mockStartPending = false;
let mockDeletePending = false;
let mutationCallIndex = 0;

vi.mock('react-router', () => ({
  useParams: () => ({ id: 'bot-test-1' }),
  useNavigate: () => mockNavigate,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(({ queryKey }: { queryKey: unknown[] }) => {
    const key = queryKey[0] as string;
    if (key === 'bots') {
      return { data: mockBotData, isLoading: mockBotIsLoading, isError: mockBotIsError, error: mockBotError, refetch: mockRefetch };
    }
    if (key === 'journal') {
      return {
        data: { events: mockJournalEvents },
        isLoading: mockJournalIsLoading,
        isSuccess: !mockJournalIsLoading,
        isError: false,
        error: null,
      };
    }
    // positions
    return {
      data: { positions: mockPositions },
      isLoading: mockPositionsIsLoading,
      isSuccess: !mockPositionsIsLoading,
      isError: false,
      error: null,
    };
  }),
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  useMutation: vi.fn(({ onSuccess }: { onSuccess?: () => void; onError?: (err: Error) => void }) => {
    // Map call order: stop=0, start=1, delete=2
    const idx = mutationCallIndex++;
    const pendingMap = [mockStopPending, mockStartPending, mockDeletePending];
    const isPending = pendingMap[idx] ?? false;

    return {
      mutate: mockMutate.mockImplementation(() => onSuccess?.()),
      mutateAsync: mockMutate,
      isPending,
      isError: false,
      error: null,
      reset: vi.fn(),
    };
  }),
}));

vi.mock('../../../lib/api-client.js', () => ({
  bots: {
    get: vi.fn(),
    openPositions: vi.fn(),
    stop: vi.fn(),
    start: vi.fn(),
    delete: vi.fn(),
  },
  journal: {
    query: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('../../../lib/useEventStream.js', () => ({
  useEventStream: vi.fn(),
}));

vi.mock('../../timeline/TimelineEvent.js', () => ({
  TimelineEvent: ({ event }: { event: { id: string; type: string } }) => `<div data-testid="timeline-event">${event.type}</div>`,
}));

// ── Helpers ─────────────────────────────────────────────────────────────

function makeBot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'bot-test-1',
    status: 'stopped',
    venueAccountId: 'va-1',
    creatorType: 'user',
    creatorId: 'user-1',
    config: {
      strategy: { type: 'momentum' },
      execution: { mode: 'paper' },
      symbol: 'BTC-PERP',
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    stoppedAt: null,
    ...overrides,
  };
}

async function renderPage(): Promise<string> {
  // Reset mutation call index for each render
  mutationCallIndex = 0;
  // Dynamic import to pick up mocks
  const { InstanceDetailPage } = await import('../../instances/detail/InstanceDetailPage.js');
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={enMessages}>
      <InstanceDetailPage />
    </IntlProvider>,
  );
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('InstanceDetailPage lifecycle buttons', () => {
  beforeEach(() => {
    mockBotData = null;
    mockBotIsLoading = true;
    mockBotIsError = false;
    mockBotError = null;
    mockPositions = [];
    mockPositionsIsLoading = false;
    mockJournalEvents = [];
    mockJournalIsLoading = false;
    mockStopPending = false;
    mockStartPending = false;
    mockDeletePending = false;
    mutationCallIndex = 0;
    mockNavigate.mockReset();
    mockMutate.mockReset();
    mockInvalidateQueries.mockReset();
    mockRefetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading skeleton when bot is loading', async () => {
    mockBotIsLoading = true;
    const html = await renderPage();
    // LoadingRows renders animated skeleton divs with pulse animation
    expect(html).toContain('pulse');
    expect(html).toContain('page-shell-responsive');
  });

  it('renders not-found state when bot is null', async () => {
    mockBotIsLoading = false;
    mockBotData = null;
    const html = await renderPage();
    expect(html).toContain('Bot not found');
  });

  it('renders Stop button when bot status is running', async () => {
    mockBotIsLoading = false;
    mockBotData = makeBot({ status: 'running', startedAt: new Date().toISOString() });
    const html = await renderPage();
    expect(html).toContain('Stop');
    // Should not show Start or Delete while running
    expect(html).not.toContain('>Start<');
    expect(html).not.toContain('>Delete<');
  });

  it('renders Start and Delete buttons when bot status is stopped', async () => {
    mockBotIsLoading = false;
    mockBotData = makeBot({ status: 'stopped' });
    const html = await renderPage();
    expect(html).toContain('>Start<');
    expect(html).toContain('>Delete<');
    // Should not show Stop while stopped
    expect(html).not.toContain('>Stop<');
  });

  it('renders Start and Delete buttons when bot status is crashed', async () => {
    mockBotIsLoading = false;
    mockBotData = makeBot({ status: 'crashed', stoppedAt: new Date().toISOString() });
    const html = await renderPage();
    expect(html).toContain('>Start<');
    expect(html).toContain('>Delete<');
  });

  it('renders crash error banner when status is crashed', async () => {
    mockBotIsLoading = false;
    mockBotData = makeBot({ status: 'crashed' });
    const html = await renderPage();
    expect(html).toContain('crashed during startup');
  });

  it('shows Starting… when start mutation is pending', async () => {
    mockBotIsLoading = false;
    mockBotData = makeBot({ status: 'stopped' });
    mockStartPending = true;
    const html = await renderPage();
    expect(html).toContain('Starting…');
  });

  it('shows Stopping… when stop mutation is pending', async () => {
    mockBotIsLoading = false;
    mockBotData = makeBot({ status: 'running', startedAt: new Date().toISOString() });
    mockStopPending = true;
    const html = await renderPage();
    expect(html).toContain('Stopping…');
  });

  it('shows Deleting… when delete mutation is pending', async () => {
    mockBotIsLoading = false;
    mockBotData = makeBot({ status: 'stopped' });
    mockDeletePending = true;
    const html = await renderPage();
    expect(html).toContain('Deleting…');
  });

  it('hides Delete button when start mutation is pending', async () => {
    mockBotIsLoading = false;
    mockBotData = makeBot({ status: 'stopped' });
    mockStartPending = true;
    const html = await renderPage();
    expect(html).toContain('Starting…');
    expect(html).not.toContain('>Delete<');
    expect(html).not.toContain('Deleting…');
  });

  it('hides Start button when running (shows Stop only)', async () => {
    mockBotIsLoading = false;
    mockBotData = makeBot({ status: 'running', startedAt: new Date().toISOString() });
    const html = await renderPage();
    expect(html).toContain('>Stop<');
    expect(html).not.toContain('>Start<');
    expect(html).not.toContain('>Delete<');
  });
});

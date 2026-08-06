/**
 * Tests for LandingPagePlaceholder — landing page with "Try it" CTA.
 *
 * Uses renderToStaticMarkup (no DOM) in line with existing codebase patterns.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockUseSession = vi.fn(() => ({
  user: null,
  loading: false,
  login: vi.fn(),
  logout: vi.fn(),
  authenticated: false,
  refresh: vi.fn(),
}));

vi.mock('../../app/providers/SessionProvider.js', () => ({
  useSession: () => mockUseSession(),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

import { LandingPagePlaceholder } from './LandingPagePlaceholder.js';

function renderPage(): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <MemoryRouter>
        <LandingPagePlaceholder />
      </MemoryRouter>
    </IntlProvider>,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('LandingPagePlaceholder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSession.mockReturnValue({
      user: null,
      loading: false,
      login: vi.fn(),
      logout: vi.fn(),
      authenticated: false,
      refresh: vi.fn(),
    });
  });

  it('renders without crashing', () => {
    const html = renderPage();
    expect(html).toBeDefined();
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('contains a link to /try', () => {
    const html = renderPage();
    expect(html).toContain('href="/try"');
  });

  it('contains a link to /login', () => {
    const html = renderPage();
    expect(html).toContain('href="/login"');
  });

  it('displays the "Try it" CTA text', () => {
    const html = renderPage();
    expect(html).toContain('Try it');
  });

  it('displays the "Sign in" CTA text', () => {
    const html = renderPage();
    expect(html).toContain('Sign in');
  });

  it('displays the tagline from vision.md', () => {
    const html = renderPage();
    expect(html).toContain('Low cost AI agents that trade, assist, research and more');
  });

  it('renders the BrandLogo component (verified via rendered brand mark image)', () => {
    const html = renderPage();
    // BrandLogo renders as a span with brand images and wordmark, not as "BrandLogo" string
    expect(html).toContain('compact-mark.png');
    expect(html).toContain('OpenAIdom');
  });
});

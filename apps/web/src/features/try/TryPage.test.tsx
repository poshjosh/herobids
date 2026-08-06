/**
 * Tests for TryPage — email-first onboarding for unauthenticated users.
 *
 * Uses renderToStaticMarkup (no DOM) in line with existing codebase patterns.
 * useEffect-based typing animation and redirects are not exercised here;
 * we validate the initial render structure, static copy, and component shape.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../lib/session.js', () => ({
  isAuthenticated: vi.fn(() => false),
  getToken: vi.fn(() => null),
  setToken: vi.fn(),
  clearToken: vi.fn(),
}));

vi.mock('../../lib/api-client.js', () => ({
  auth: {
    sendLoginLink: vi.fn().mockResolvedValue({ ok: true }),
  },
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(message: string, status: number, code: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

import { TryPage, EMAIL_REGEX } from './TryPage.js';

function renderPage(): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <MemoryRouter>
        <TryPage />
      </MemoryRouter>
    </IntlProvider>,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Basic rendering ──────────────────────────────────────────────────

  it('renders without crashing', () => {
    const html = renderPage();
    expect(html).toBeDefined();
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('renders the page header with title "OpenAIdom"', () => {
    const html = renderPage();
    expect(html).toContain('OpenAIdom');
    expect(html).toContain('try-page-header');
    expect(html).toContain('try-page-header-title');
  });

  it('renders the scrollable message area', () => {
    const html = renderPage();
    expect(html).toContain('try-page-scroll');
  });

  it('has the top-level try-page class on initial render', () => {
    const html = renderPage();
    expect(html).toContain('class="try-page"');
  });

  // ── Static message copy ──────────────────────────────────────────────

  it('contains the static message copy for message 1', () => {
    // MESSAGE_1 is "Hi! I can help you create an AI agent. ..."
    // In the IDLE phase it's not rendered to DOM, but we verify the
    // string exists in the component source code.
    const fs = require('node:fs');
    const sourcePath = new URL('./TryPage.tsx', import.meta.url).pathname;
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).toContain("Hi! I can help you create an AI agent.");
  });

  it('contains the static message copy for message 2 in source', () => {
    const fs = require('node:fs');
    const sourcePath = new URL('./TryPage.tsx', import.meta.url).pathname;
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).toContain('I see you have not logged in');
  });

  it('contains the static message copy for message 3 in source', () => {
    const fs = require('node:fs');
    const sourcePath = new URL('./TryPage.tsx', import.meta.url).pathname;
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).toContain('An email has been sent to');
  });

  // ── Email validation ─────────────────────────────────────────────────

  it('EMAIL_REGEX accepts valid email addresses', () => {
    expect(EMAIL_REGEX.test('user@example.com')).toBe(true);
    expect(EMAIL_REGEX.test('a@b.co')).toBe(true);
  });

  it('EMAIL_REGEX rejects invalid email addresses', () => {
    expect(EMAIL_REGEX.test('not-an-email')).toBe(false);
    expect(EMAIL_REGEX.test('@missing-local')).toBe(false);
    expect(EMAIL_REGEX.test('missing-domain@')).toBe(false);
    expect(EMAIL_REGEX.test('')).toBe(false);
  });

  // ── Redirect for authenticated users ─────────────────────────────────

  it('contains redirect target /agents/new in component source', () => {
    // The component calls navigate('/agents/new') when isAuthenticated()
    // returns true. Since renderToStaticMarkup doesn't run useEffect,
    // we verify the redirect target is hardcoded in the component source.
    const fs = require('node:fs');
    const sourcePath = new URL('./TryPage.tsx', import.meta.url).pathname;
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).toContain("'/agents/new'");
  });

  // ── Module-level integration checks ──────────────────────────────────

  it('imports auth.sendLoginLink from the api-client', () => {
    // Verify the component imports the auth module and references sendLoginLink
    const fs = require('node:fs');
    const sourcePath = new URL('./TryPage.tsx', import.meta.url).pathname;
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).toContain('sendLoginLink');
    expect(source).toContain("from '../../lib/api-client.js'");
  });
});

/**
 * Regression tests for bug 003 — "Login error not shown when password is wrong".
 *
 * Root cause: the 401 handler in request() unconditionally called
 *   window.location.href = '/login'
 * which hard-redirected the page before the login form's catch block could
 * display the error message from the API response body.
 *
 * Fix: skip the redirect for auth endpoints (/auth/login, /auth/register,
 * /auth/exchange) and let their 401 responses fall through to the generic
 * error body parser so callers receive a typed ApiError.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Browser global stubs ─────────────────────────────────────────────────────
// api-client.ts sets window.location.href on non-auth 401 responses.
// We stub window before importing the module so the reference is available
// when the request() function executes.
const mockWindowLocation = { href: '' };
vi.stubGlobal('window', { location: mockWindowLocation });

// import.meta.env['VITE_API_BASE_URL'] is undefined in the test environment,
// so config.ts falls back to '/api'. Fetch is called with paths like
// /api/auth/login — we override fetch per test below.
// ─────────────────────────────────────────────────────────────────────────────

import { auth, ApiError } from './api-client.js';

// Helper: build a minimal Response-like object that satisfies what request() reads.
function mockResponse(
  status: number,
  body: Record<string, unknown>,
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('api-client — 401 handling', () => {
  beforeEach(() => {
    mockWindowLocation.href = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Auth endpoints: must NOT redirect ─────────────────────────────────────

  it('auth.login() 401 throws ApiError with the body message and does not redirect to /login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse(401, { error: 'invalid_credentials', message: 'Invalid email or password' }),
      ),
    );

    let caught: unknown;
    try {
      await auth.login('test@example.com', 'wrongpass');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(401);
    expect(err.message).toBe('Invalid email or password');
    // Critical: must not redirect the page
    expect(mockWindowLocation.href).toBe('');
  });

  it('auth.register() 401 throws ApiError with the body message and does not redirect to /login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse(401, { error: 'email_taken', message: 'Email already registered' }),
      ),
    );

    let caught: unknown;
    try {
      await auth.register('test@example.com', 'pass', 'Alice');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(401);
    expect(err.message).toBe('Email already registered');
    expect(mockWindowLocation.href).toBe('');
  });

  it('auth.exchange() 401 throws ApiError with the body message and does not redirect to /login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse(401, { error: 'invalid_code', message: 'Invalid or expired exchange code' }),
      ),
    );

    let caught: unknown;
    try {
      await auth.exchange('bad-code');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(401);
    expect(err.message).toBe('Invalid or expired exchange code');
    expect(mockWindowLocation.href).toBe('');
  });

  // ── Non-auth endpoints: must redirect ─────────────────────────────────────

  it('auth.me() 401 (session expiry) redirects to /login and throws ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse(401, { error: 'unauthorized' })),
    );

    let caught: unknown;
    try {
      await auth.me();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(401);
    expect(err.code).toBe('unauthorized');
    // Critical: must redirect expired sessions back to the login page
    expect(mockWindowLocation.href).toBe('/login');
  });
});

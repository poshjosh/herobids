import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useIntl } from 'react-intl';
import { auth } from '../../lib/api-client.js';
import { useSession } from '../../app/providers/SessionProvider.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

type CallbackState = 'loading' | 'error';

/**
 * Sanitize a frontend `next` path for redirect-after-auth flows.
 * Matches the API-side `sanitizeNextParam` rule:
 * - Requires a single-leading-slash relative path
 * - Rejects protocol-relative (`//evil.com`) and absolute URLs
 * - Normalizes via `new URL(value, origin)` and verifies same-origin
 * - Falls back to `/agents` on invalid/missing
 */
export function sanitizeNextParam(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return '/agents';
  }
  try {
    const normalized = new URL(value, window.location.origin);
    if (normalized.origin !== window.location.origin) {
      return '/agents';
    }
    return `${normalized.pathname}${normalized.search}${normalized.hash}`;
  } catch {
    return '/agents';
  }
}

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const { login } = useSession();
  const intl = useIntl();
  const [state, setState] = useState<CallbackState>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const ran = useRef(false);

  useEffect(() => {
    // Strict-mode double-invoke guard — exchange code is one-time-use
    if (ran.current) return;
    ran.current = true;

    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');

    if (!code) {
      setState('error');
      setErrorMessage(intl.formatMessage({ id: 'auth.callback.missingCode' }));
      return;
    }

    const next = url.searchParams.get('next');
    // Same-origin sanitizer matching the API-side sanitizeNextParam rule:
    // rejects protocol-relative (`//evil.com`), absolute URLs, and cross-origin.
    const safeNext = sanitizeNextParam(next);

    auth.exchange(code)
      .then(({ token }) => login(token))
      .then(() => navigate(safeNext, { replace: true }))
      .catch((err: unknown) => {
        setState('error');
        setErrorMessage(localizeApiError(intl, err, 'auth.error.default'));
      });
  }, [login, navigate, intl]);

  if (state === 'error') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: '400px', padding: '24px' }}>
          <div style={{ fontSize: '20px', fontWeight: '600', marginBottom: '12px', color: 'var(--color-danger)' }}>
            {intl.formatMessage({ id: 'auth.callback.signInFailed' })}
          </div>
          <div style={{ color: 'var(--color-text-secondary)', marginBottom: '24px' }}>{errorMessage}</div>
          <a href="/login" style={{ color: 'var(--color-brand)', textDecoration: 'none' }}>
            {intl.formatMessage({ id: 'auth.callback.backToSignIn' })}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
        <Spinner />
        <div style={{ color: 'var(--color-text-secondary)' }}>
          {intl.formatMessage({ id: 'auth.callback.signingIn' })}
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div
      style={{
        width: '32px',
        height: '32px',
        border: '3px solid var(--color-surface-3)',
        borderTopColor: 'var(--color-brand)',
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
      }}
    />
  );
}

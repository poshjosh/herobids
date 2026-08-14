import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useIntl } from 'react-intl';
import { config } from '../../lib/config.js';
import { auth } from '../../lib/api-client.js';
import { useSession } from '../../app/providers/SessionProvider.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { BrandLogo } from '../../brand/BrandLogo.js';

type PageState = 'passwordCollapsed' | 'passwordExpanded' | 'sendingLoginLink' | 'signingInWithPassword' | 'loginLinkSent' | 'resendingLoginLink';

export function LoginPage() {
  const navigate = useNavigate();
  const { login } = useSession();
  const intl = useIntl();

  const [pageState, setPageState] = useState<PageState>('passwordCollapsed');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newUser, setNewUser] = useState(false);
  const [username, setUsername] = useState('');
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 480px)');
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const isPasswordExpanded = pageState === 'passwordExpanded' || pageState === 'signingInWithPassword';
  const isLinkSent = pageState === 'loginLinkSent' || pageState === 'resendingLoginLink';

  async function handleSendLoginLink() {
    if (!email) return;
    setError(null);
    setPending(true);
    setPageState('sendingLoginLink');
    try {
      await auth.sendLoginLink(email, newUser && username ? username : undefined);
      setPageState('loginLinkSent');
    } catch (err) {
      setError(localizeApiError(intl, err, 'auth.error.default'));
      setPageState(isPasswordExpanded ? 'passwordExpanded' : 'passwordCollapsed');
    } finally {
      setPending(false);
    }
  }

  async function handlePasswordSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;
    setError(null);
    setPending(true);
    setPageState('signingInWithPassword');
    try {
      const { token } = await auth.login(email, password);
      await login(token);
      navigate('/agents', { replace: true });
    } catch (err) {
      setError(localizeApiError(intl, err, 'auth.error.default'));
      setPageState('passwordExpanded');
    } finally {
      setPending(false);
    }
  }

  function expandPassword() {
    setError(null);
    setPageState('passwordExpanded');
  }

  function handleEmailKeyDown(e: React.KeyboardEvent) {
    // Pressing Enter in the collapsed state sends a login link
    if (e.key === 'Enter' && !isPasswordExpanded) {
      e.preventDefault();
      void handleSendLoginLink();
    }
  }

  async function handleResendLink() {
    if (!email) return;
    setError(null);
    setPending(true);
    setPageState('resendingLoginLink');
    try {
      await auth.sendLoginLink(email, newUser && username ? username : undefined);
      setPageState('loginLinkSent');
    } catch (err) {
      setError(localizeApiError(intl, err, 'auth.error.default'));
      setPageState('loginLinkSent');
    } finally {
      setPending(false);
    }
  }

  // --- Login-link sent state ---
  if (isLinkSent) {
    return (
      <PageShell>
        <div style={{ textAlign: 'center' }}>
          {/* Mail icon */}
          <div style={{ fontSize: '3rem', marginBottom: '16px', opacity: 0.6 }}>✉️</div>
          <div style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '8px', color: 'var(--color-text-primary)' }}>
            {intl.formatMessage({ id: 'auth.loginLinkSent.title' })}
          </div>
          <div style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', marginBottom: '24px', lineHeight: '1.5' }}>
            {intl.formatMessage({ id: 'auth.loginLinkSent.message' })}
          </div>
          {error && (
            <div style={{
              fontSize: '0.8125rem', color: 'var(--color-danger, #e05252)',
              padding: '10px 12px', background: 'rgba(224,82,82,0.08)',
              borderRadius: '6px', marginBottom: '16px',
            }}>
              {error}
            </div>
          )}
          <button
            type="button"
            onClick={() => { void handleResendLink(); }}
            disabled={pending}
            style={{
              padding: '10px 24px',
              background: 'var(--color-brand)',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '0.875rem',
              fontWeight: '500',
              cursor: pending ? 'not-allowed' : 'pointer',
              opacity: pending ? 0.7 : 1,
            }}
          >
            {pending
              ? intl.formatMessage({ id: 'common.loading' })
              : intl.formatMessage({ id: 'auth.loginLinkSent.resend' })}
          </button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <form onSubmit={(e) => { void handlePasswordSignIn(e); }} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {/* Username field — shown for new users */}
        {newUser && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label htmlFor="login-username" style={{ fontSize: '0.8125rem', fontWeight: '500', color: 'var(--color-text-secondary)' }}>
              {intl.formatMessage({ id: 'auth.username.label' })}
            </label>
            <input
              id="login-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={intl.formatMessage({ id: 'auth.username.placeholder' })}
              autoComplete="username"
              style={inputStyle}
            />
          </div>
        )}

        {/* Email field */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label htmlFor="login-email" style={{ fontSize: '0.8125rem', fontWeight: '500', color: 'var(--color-text-secondary)' }}>
            {intl.formatMessage({ id: 'auth.email.email.label' })}
          </label>
          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={handleEmailKeyDown}
            placeholder="you@example.com"
            required
            autoComplete="email"
            autoFocus
            style={inputStyle}
          />
        </div>

        {/* Password field — conditionally rendered */}
        {isPasswordExpanded && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label htmlFor="login-password" style={{ fontSize: '0.8125rem', fontWeight: '500', color: 'var(--color-text-secondary)' }}>
              {intl.formatMessage({ id: 'auth.email.password.label' })}
            </label>
            <div style={{ position: 'relative' }}>
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder=""
                required
                autoComplete="current-password"
                style={{ ...inputStyle, paddingRight: '44px' }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: 'absolute',
                  right: '8px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                  color: 'var(--color-text-muted)',
                  padding: '4px',
                }}
                aria-label={showPassword ? intl.formatMessage({ id: 'auth.password.hide' }) : intl.formatMessage({ id: 'auth.password.show' })}
              >
                {showPassword ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ fontSize: '0.8125rem', color: 'var(--color-danger, #e05252)', padding: '10px 12px', background: 'rgba(224,82,82,0.08)', borderRadius: '6px' }}>
            {error}
          </div>
        )}

        {/* Action row: Send login link + Sign in with password / Sign in */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {isPasswordExpanded ? (
            <>
              <button
                type="button"
                onClick={() => { void handleSendLoginLink(); }}
                disabled={pending || !email}
                style={{
                  flex: 1,
                  padding: '12px',
                  background: 'var(--color-surface-2)',
                  color: 'var(--color-text-primary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '8px',
                  fontSize: '0.9375rem',
                  fontWeight: '500',
                  cursor: pending || !email ? 'not-allowed' : 'pointer',
                  opacity: pending || !email ? 0.5 : 1,
                }}
              >
                {pending && pageState === 'sendingLoginLink'
                  ? intl.formatMessage({ id: 'common.loading' })
                  : newUser
                    ? intl.formatMessage({ id: 'auth.sendRegistrationLink' })
                    : intl.formatMessage({ id: isMobile ? 'auth.sendLoginLink.mobile' : 'auth.sendLoginLink' })}
              </button>
              <button
                type="submit"
                disabled={pending || !email || !password}
                style={{
                  flex: 1,
                  padding: '12px',
                  background: 'var(--color-brand)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '0.9375rem',
                  fontWeight: '500',
                  cursor: pending || !email || !password ? 'not-allowed' : 'pointer',
                  opacity: pending || !email || !password ? 0.7 : 1,
                }}
              >
                {pending && pageState === 'signingInWithPassword'
                  ? intl.formatMessage({ id: 'common.loading' })
                  : intl.formatMessage({ id: 'auth.signIn' })}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => { void handleSendLoginLink(); }}
                disabled={pending || !email}
                style={{
                  flex: 1,
                  padding: '12px',
                  background: 'var(--color-brand)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '0.9375rem',
                  fontWeight: '500',
                  cursor: pending || !email ? 'not-allowed' : 'pointer',
                  opacity: pending || !email ? 0.7 : 1,
                }}
              >
                {pending && pageState === 'sendingLoginLink'
                  ? intl.formatMessage({ id: 'common.loading' })
                  : newUser
                    ? intl.formatMessage({ id: 'auth.sendRegistrationLink' })
                    : intl.formatMessage({ id: isMobile ? 'auth.sendLoginLink.mobile' : 'auth.sendLoginLink' })}
              </button>
              <button
                type="button"
                onClick={expandPassword}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '0.8125rem',
                  color: 'var(--color-text-muted)',
                  textDecoration: 'underline',
                  whiteSpace: 'nowrap',
                  padding: '12px 8px',
                }}
              >
                {intl.formatMessage({ id: isMobile ? 'auth.signInWithPassword.mobile' : 'auth.signInWithPassword' })}
              </button>
            </>
          )}
        </div>
        {/* New user / Existing user toggle */}
        <div style={{ textAlign: 'center', marginTop: '-2px' }}>
          <button
            type="button"
            onClick={() => {
              if (newUser) { setNewUser(false); setUsername(''); setError(null); }
              else { setNewUser(true); setError(null); }
            }}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.8125rem',
              color: 'var(--color-text-muted)',
              textDecoration: 'underline',
              padding: '4px 0',
            }}
          >
            {intl.formatMessage({ id: newUser ? 'auth.existingUser' : 'auth.newUser' })}
          </button>
        </div>
      </form>

      {/* Divider — hidden on mobile */}
      {!isMobile && (
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '8px 0' }}>
        <div style={{ flex: 1, height: '1px', background: 'var(--color-border)' }} />
        <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'auth.divider.or' })}</span>
        <div style={{ flex: 1, height: '1px', background: 'var(--color-border)' }} />
      </div>
      )}

      {/* Google sign-in — styled per https://developers.google.com/identity/branding-guidelines (light theme) */}
      <a
        href={config.googleAuthUrl}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          padding: '10px 12px',
          background: '#FFFFFF',
          color: '#1F1F1F',
          borderRadius: '8px',
          border: '1px solid #747775',
          textDecoration: 'none',
          fontSize: '14px',
          lineHeight: '20px',
          fontFamily: "'Google Sans', Roboto, Arial, sans-serif",
          fontWeight: '500',
          cursor: 'pointer',
          transition: 'background 0.15s, box-shadow 0.15s',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = '#CCCCCC'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = '#FFFFFF'; }}
      >
        <GoogleIcon />
        {intl.formatMessage({ id: 'auth.continueWithGoogle' })}
      </a>

      <div style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem', textAlign: 'center' }}>
        {intl.formatMessage({ id: 'auth.terms' })}
      </div>
    </PageShell>
  );
}

/** Shared page shell used by all states */
function PageShell({ children }: { children: React.ReactNode }) {
  const intl = useIntl();
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        padding: '24px',
      }}
    >
      <div className="auth-card">
        <div style={{ textAlign: 'center' }}>
          <div style={{ marginBottom: '8px' }}>
            <BrandLogo display="full" variant="auto" size="lg" />
          </div>
          <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.9375rem', marginBottom: '20px' }}>
            {intl.formatMessage({ id: 'auth.tagline' })}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  background: 'var(--color-surface-0)',
  border: '1px solid var(--color-border)',
  borderRadius: '6px',
  fontSize: '0.875rem',
  color: 'var(--color-text-primary)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

function GoogleIcon() {
  // Official pre-approved asset (developers.google.com/identity/branding-guidelines) — the "G" uses a gradient, not flat colors
  return <img src="/brand/google-g-logo.svg" alt="Google logo" />;
}

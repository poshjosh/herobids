import { useState } from 'react';
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
          <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.6 }}>✉️</div>
          <div style={{ fontSize: '20px', fontWeight: '600', marginBottom: '8px', color: 'var(--color-text-primary)' }}>
            {intl.formatMessage({ id: 'auth.loginLinkSent.title' })}
          </div>
          <div style={{ fontSize: '14px', color: 'var(--color-text-secondary)', marginBottom: '24px', lineHeight: '1.5' }}>
            {intl.formatMessage({ id: 'auth.loginLinkSent.message' })}
          </div>
          {error && (
            <div style={{
              fontSize: '13px', color: 'var(--color-danger, #e05252)',
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
              fontSize: '14px',
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
            <label htmlFor="login-username" style={{ fontSize: '13px', fontWeight: '500', color: 'var(--color-text-secondary)' }}>
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
          <label htmlFor="login-email" style={{ fontSize: '13px', fontWeight: '500', color: 'var(--color-text-secondary)' }}>
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
            <label htmlFor="login-password" style={{ fontSize: '13px', fontWeight: '500', color: 'var(--color-text-secondary)' }}>
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
                  fontSize: '12px',
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
          <div style={{ fontSize: '13px', color: 'var(--color-danger, #e05252)', padding: '10px 12px', background: 'rgba(224,82,82,0.08)', borderRadius: '6px' }}>
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
                  fontSize: '15px',
                  fontWeight: '500',
                  cursor: pending || !email ? 'not-allowed' : 'pointer',
                  opacity: pending || !email ? 0.5 : 1,
                }}
              >
                {pending && pageState === 'sendingLoginLink'
                  ? intl.formatMessage({ id: 'common.loading' })
                  : newUser
                    ? intl.formatMessage({ id: 'auth.sendRegistrationLink' })
                    : intl.formatMessage({ id: 'auth.sendLoginLink' })}
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
                  fontSize: '15px',
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
                  fontSize: '15px',
                  fontWeight: '500',
                  cursor: pending || !email ? 'not-allowed' : 'pointer',
                  opacity: pending || !email ? 0.7 : 1,
                }}
              >
                {pending && pageState === 'sendingLoginLink'
                  ? intl.formatMessage({ id: 'common.loading' })
                  : newUser
                    ? intl.formatMessage({ id: 'auth.sendRegistrationLink' })
                    : intl.formatMessage({ id: 'auth.sendLoginLink' })}
              </button>
              <button
                type="button"
                onClick={expandPassword}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: 'var(--color-text-muted)',
                  textDecoration: 'underline',
                  whiteSpace: 'nowrap',
                  padding: '12px 8px',
                }}
              >
                {intl.formatMessage({ id: 'auth.signInWithPassword' })}
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
              fontSize: '13px',
              color: 'var(--color-text-muted)',
              textDecoration: 'underline',
              padding: '4px 0',
            }}
          >
            {intl.formatMessage({ id: newUser ? 'auth.existingUser' : 'auth.newUser' })}
          </button>
        </div>
      </form>

      {/* Divider */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '8px 0' }}>
        <div style={{ flex: 1, height: '1px', background: 'var(--color-border)' }} />
        <span style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'auth.divider.or' })}</span>
        <div style={{ flex: 1, height: '1px', background: 'var(--color-border)' }} />
      </div>

      {/* Google sign-in */}
      <a
        href={config.googleAuthUrl}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          padding: '12px 20px',
          background: '#FFFFFF',
          color: 'rgba(0,0,0,0.54)',
          borderRadius: '8px',
          border: '1px solid var(--color-border)',
          textDecoration: 'none',
          fontSize: '15px',
          fontWeight: '500',
          cursor: 'pointer',
          transition: 'background 0.15s, box-shadow 0.15s',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = '#F5F5F5'; (e.currentTarget as HTMLAnchorElement).style.boxShadow = '0 1px 3px rgba(0,0,0,0.12)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = '#FFFFFF'; (e.currentTarget as HTMLAnchorElement).style.boxShadow = 'none'; }}
      >
        <GoogleIcon />
        {intl.formatMessage({ id: 'auth.continueWithGoogle' })}
      </a>

      <div style={{ color: 'var(--color-text-muted)', fontSize: '12px', textAlign: 'center' }}>
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
          <div style={{ color: 'var(--color-text-secondary)', fontSize: '15px', marginBottom: '20px' }}>
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
  fontSize: '14px',
  color: 'var(--color-text-primary)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  );
}

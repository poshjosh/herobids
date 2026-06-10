import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useIntl } from 'react-intl';
import { config } from '../../lib/config.js';
import { auth } from '../../lib/api-client.js';
import { useSession } from '../../app/providers/SessionProvider.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

type EmailMode = 'login' | 'register';

export function LoginPage() {
  const navigate = useNavigate();
  const { login } = useSession();
  const intl = useIntl();

  // 'email' tab state
  const [tab, setTab] = useState<'google' | 'email'>('google');
  const [emailMode, setEmailMode] = useState<EmailMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const { token } = emailMode === 'register'
        ? await auth.register(email, password, displayName)
        : await auth.login(email, password);
      await login(token);
      navigate('/mission-control', { replace: true });
    } catch (err) {
      setError(localizeApiError(intl, err, 'auth.error.default'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-surface-0)',
        padding: '24px',
      }}
    >
      <div className="auth-card">
        {/* Brand */}
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontSize: '28px',
              fontWeight: '700',
              color: 'var(--color-brand)',
              letterSpacing: '-0.5px',
              marginBottom: '8px',
            }}
          >
            Herobids
          </div>
          <div style={{ color: 'var(--color-text-secondary)', fontSize: '15px' }}>
            {intl.formatMessage({ id: 'auth.tagline' })}
          </div>
        </div>

        {/* Tab switcher */}
        <div role="tablist" style={{ display: 'flex', gap: '4px', background: 'var(--color-surface-0)', borderRadius: '8px', padding: '4px' }}>
          {(['google', 'email'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => { setTab(t); setError(null); }}
              style={{
                flex: 1,
                padding: '8px',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '500',
                background: tab === t ? 'var(--color-surface-1)' : 'transparent',
                color: tab === t ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                boxShadow: tab === t ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                transition: 'all 0.15s',
              }}
            >
              {t === 'google'
                ? intl.formatMessage({ id: 'auth.tab.google' })
                : intl.formatMessage({ id: 'auth.tab.email' })}
            </button>
          ))}
        </div>

        {/* Sign-in panel */}
        {tab === 'google' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <a
              href={config.googleAuthUrl}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                padding: '12px 20px',
                background: 'white',
                color: '#3c4043',
                borderRadius: '8px',
                border: '1px solid #dadce0',
                textDecoration: 'none',
                fontSize: '15px',
                fontWeight: '500',
                cursor: 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = '#f8f9fa'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = 'white'; }}
            >
              <GoogleIcon />
              {intl.formatMessage({ id: 'auth.continueWithGoogle' })}
            </a>
          </div>
        ) : (
          <form onSubmit={(e) => { void handleEmailSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {emailMode === 'register' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label htmlFor="login-name" style={{ fontSize: '13px', fontWeight: '500', color: 'var(--color-text-secondary)' }}>
                  {intl.formatMessage({ id: 'auth.email.name.label' })}
                </label>
                <input
                  id="login-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={intl.formatMessage({ id: 'auth.email.name.placeholder' })}
                  required
                  autoComplete="name"
                  style={inputStyle}
                />
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="login-email" style={{ fontSize: '13px', fontWeight: '500', color: 'var(--color-text-secondary)' }}>
                {intl.formatMessage({ id: 'auth.email.email.label' })}
              </label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
                style={inputStyle}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="login-password" style={{ fontSize: '13px', fontWeight: '500', color: 'var(--color-text-secondary)' }}>
                {intl.formatMessage({ id: 'auth.email.password.label' })}
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={emailMode === 'register' ? intl.formatMessage({ id: 'auth.email.password.placeholder' }) : ''}
                required
                autoComplete={emailMode === 'register' ? 'new-password' : 'current-password'}
                style={inputStyle}
              />
            </div>

            {error && (
              <div style={{ fontSize: '13px', color: 'var(--color-danger, #e05252)', padding: '10px 12px', background: 'rgba(224,82,82,0.08)', borderRadius: '6px' }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={pending}
              style={{
                padding: '12px',
                background: 'var(--color-brand)',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontSize: '15px',
                fontWeight: '500',
                cursor: pending ? 'not-allowed' : 'pointer',
                opacity: pending ? 0.7 : 1,
              }}
            >
              {pending
                ? intl.formatMessage({ id: 'auth.pendingSubmit' })
                : emailMode === 'register'
                  ? intl.formatMessage({ id: 'auth.register.submit' })
                  : intl.formatMessage({ id: 'auth.login.submit' })}
            </button>

            <button
              type="button"
              onClick={() => { setEmailMode(emailMode === 'login' ? 'register' : 'login'); setError(null); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: 'var(--color-text-muted)', textDecoration: 'underline' }}
            >
              {emailMode === 'login'
                ? intl.formatMessage({ id: 'auth.switchToRegister' })
                : intl.formatMessage({ id: 'auth.switchToLogin' })}
            </button>
          </form>
        )}

        <div style={{ color: 'var(--color-text-muted)', fontSize: '12px', textAlign: 'center' }}>
          {intl.formatMessage({ id: 'auth.terms' })}
        </div>
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

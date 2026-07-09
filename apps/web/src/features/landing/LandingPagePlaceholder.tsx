import { Link, Navigate } from 'react-router';
import { useSession } from '../../app/providers/SessionProvider.js';

export function LandingPagePlaceholder() {
  const { user, loading } = useSession();

  // TODO: Replace with shared LoadingSpinner when the real landing page is built
  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--color-text-muted)' }}>Loading…</div>
      </div>
    );
  }

  // Authenticated users go to /agents
  if (user) {
    return <Navigate to="/agents" replace />;
  }

  // Unauthenticated visitors see the landing page placeholder
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--color-surface-0)',
      padding: '24px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: '32px', fontWeight: '700', color: 'var(--color-brand)', marginBottom: '16px' }}>
        HeroBids
      </div>
      <div style={{ fontSize: '18px', color: 'var(--color-text-secondary)', marginBottom: '8px', maxWidth: '480px' }}>
        AI agents as a service. Describe what you want, and an agent gets it for you.
      </div>
      {/* TODO: i18n */}
      <div style={{ fontSize: '14px', color: 'var(--color-text-muted)', marginBottom: '32px' }}>
        Crypto trading • Personal assistance • And more
      </div>
      <div style={{ display: 'flex', gap: '12px' }}>
        <Link
          to="/login"
          style={{
            display: 'inline-block',
            padding: '10px 24px',
            background: 'var(--color-brand)',
            color: '#fff',
            borderRadius: '6px',
            textDecoration: 'none',
            fontSize: '14px',
            fontWeight: '600',
          }}
        >
          Sign in
        </Link>
        {/* TODO: Replace with real landing page destination */}
        <Link
          to="/en/help/get-started"
          style={{
            display: 'inline-block',
            padding: '10px 24px',
            background: 'transparent',
            color: 'var(--color-text-primary)',
            borderRadius: '6px',
            textDecoration: 'none',
            fontSize: '14px',
            fontWeight: '500',
            border: '1px solid var(--color-border-subtle)',
          }}
        >
          Learn more
        </Link>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Outlet, Navigate } from 'react-router';
import { useIntl } from 'react-intl';
import { useSession } from '../providers/SessionProvider.js';
import { Sidebar } from './Sidebar.js';

export function RootLayout() {
  const { authenticated, loading } = useSession();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const intl = useIntl();

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-surface-0)',
        }}
      >
        <LoadingSpinner />
      </div>
    );
  }

  if (!authenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="layout-root">
      {/* Backdrop — closes sidebar on mobile when tapping outside */}
      <div
        className={`layout-backdrop${sidebarOpen ? ' backdrop-open' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="layout-main" style={{ display: 'flex', flexDirection: 'column' }}>
        {/* Mobile top bar with hamburger */}
        <div className="layout-topbar">
          <button
            className="layout-hamburger"
            aria-label={intl.formatMessage({ id: 'nav.openNavigation' })}
            onClick={() => setSidebarOpen(true)}
          >
            ☰
          </button>
          <span style={{ fontSize: '16px', fontWeight: '700', color: 'var(--color-brand)' }}>
            HeroBids
          </span>
        </div>

        <div style={{ flex: 1 }}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div
      style={{
        width: '36px',
        height: '36px',
        border: '3px solid var(--color-surface-3)',
        borderTopColor: 'var(--color-brand)',
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
      }}
    />
  );
}

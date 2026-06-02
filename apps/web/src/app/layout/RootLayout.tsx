import { Outlet, Navigate } from 'react-router';
import { useSession } from '../providers/SessionProvider.js';
import { Sidebar } from './Sidebar.js';

export function RootLayout() {
  const { authenticated, loading } = useSession();

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
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--color-surface-0)' }}>
      <Sidebar />
      <main style={{ flex: 1, overflowY: 'auto', minWidth: 0 }}>
        <Outlet />
      </main>
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

import { Link, useLocation } from 'react-router';
import { useSession } from '../providers/SessionProvider.js';

const NAV_ITEMS = [
  { path: '/mission-control', label: 'Mission Control', icon: '◈' },
  { path: '/activity', label: 'Activity', icon: '◎' },
  { path: '/outcomes', label: 'Outcomes', icon: '▦' },
  { path: '/exposure', label: 'Exposure', icon: '◑' },
];

const MANAGE_ITEMS = [
  { path: '/agents', label: 'Agents', icon: '⊡' },
  { path: '/venue-accounts', label: 'Venues', icon: '⬡' },
  { path: '/credentials', label: 'Credentials', icon: '⊛' },
  { path: '/billing', label: 'Billing', icon: '⊘' },
  { path: '/settings', label: 'Settings', icon: '⊙' },
];

export function Sidebar() {
  const location = useLocation();
  const { user, logout } = useSession();

  const isActive = (path: string) => location.pathname === path || location.pathname.startsWith(path + '/');

  return (
    <nav
      style={{
        width: '216px',
        flexShrink: 0,
        background: 'var(--color-surface-1)',
        borderRight: '1px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        position: 'sticky',
        top: 0,
        overflowY: 'auto',
      }}
    >
      {/* Brand */}
      <div
        style={{
          padding: '20px 16px 16px',
          borderBottom: '1px solid var(--color-border-subtle)',
        }}
      >
        <div style={{ fontSize: '18px', fontWeight: '700', color: 'var(--color-brand)', letterSpacing: '-0.3px' }}>
          Herobids
        </div>
      </div>

      {/* Primary nav */}
      <div style={{ padding: '12px 8px 8px', flex: 1 }}>
        <NavGroup>
          {NAV_ITEMS.map((item) => (
            <NavItem key={item.path} {...item} active={isActive(item.path)} />
          ))}
        </NavGroup>

        <SectionLabel>Manage</SectionLabel>
        <NavGroup>
          {MANAGE_ITEMS.map((item) => (
            <NavItem key={item.path} {...item} active={isActive(item.path)} />
          ))}
        </NavGroup>
      </div>

      {/* User footer */}
      {user && (
        <div
          style={{
            padding: '12px',
            borderTop: '1px solid var(--color-border-subtle)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                style={{ width: '28px', height: '28px', borderRadius: '50%' }}
              />
            ) : (
              <div
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  background: 'var(--color-brand-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: '600',
                  color: 'var(--color-brand)',
                }}
              >
                {user.displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: '500',
                  color: 'var(--color-text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user.displayName}
              </div>
              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--color-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {user.planId}
              </div>
            </div>
          </div>
          <button
            onClick={() => void logout()}
            style={{
              width: '100%',
              padding: '6px 10px',
              background: 'transparent',
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              color: 'var(--color-text-muted)',
              fontSize: '12px',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </nav>
  );
}

function NavGroup({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '4px' }}>{children}</div>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: '10px',
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'var(--color-text-muted)',
        padding: '12px 8px 4px',
      }}
    >
      {children}
    </div>
  );
}

function NavItem({ path, label, icon, active }: { path: string; label: string; icon: string; active: boolean }) {
  return (
    <Link
      to={path}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '7px 10px',
        borderRadius: '7px',
        textDecoration: 'none',
        fontSize: '14px',
        fontWeight: active ? '500' : '400',
        color: active ? 'var(--color-brand)' : 'var(--color-text-secondary)',
        background: active ? 'var(--color-brand-subtle)' : 'transparent',
        transition: 'all 0.1s',
      }}
    >
      <span style={{ fontSize: '16px', opacity: 0.8 }}>{icon}</span>
      {label}
    </Link>
  );
}

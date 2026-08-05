import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useIntl } from 'react-intl';
import { useSession } from '../providers/SessionProvider.js';
import { BrandLogo } from '../../brand/BrandLogo.js';

export function Sidebar({ open, onClose }: { open?: boolean; onClose?: () => void }) {
  const location = useLocation();
  const { user, logout } = useSession();
  const intl = useIntl();

  const { locale } = intl;

  // Rebuild only when locale changes, not on every route re-render.
  const NAV_ITEMS = useMemo(() => [
    { path: '/agents', label: intl.formatMessage({ id: 'nav.agents' }), icon: '⊡' },
    { path: '/skills', label: intl.formatMessage({ id: 'nav.skills' }), icon: '✦' },
    { path: '/connections', label: intl.formatMessage({ id: 'nav.connections' }), icon: '⊟' },
    { path: '/activity', label: intl.formatMessage({ id: 'nav.activity' }), icon: '◈' },
    { path: '/billing', label: intl.formatMessage({ id: 'nav.billing' }), icon: '⊘' },
    { path: '/settings', label: intl.formatMessage({ id: 'nav.settings' }), icon: '⊙' },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [locale]);

  const ADVANCED_ITEMS = useMemo(() => [
    { path: '/bots', label: intl.formatMessage({ id: 'nav.bots' }), icon: '⊞' },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [locale]);

  const isActive = (path: string) => location.pathname === path || location.pathname.startsWith(path + '/');

  const isAdvancedActive = useMemo(
    () => ADVANCED_ITEMS.some((item) => isActive(item.path)),
    // ADVANCED_ITEMS is locale-stable; the real dependency is location.pathname
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [location.pathname, ADVANCED_ITEMS],
  );

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const effectiveAdvancedOpen = advancedOpen || isAdvancedActive;

  return (
    <nav
      className={`layout-sidebar${open ? ' sidebar-open' : ''}`}
    >
      {/* Brand */}
      <div
        style={{
          padding: '20px 16px 16px',
          borderBottom: '1px solid var(--color-border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <BrandLogo display="full" variant="auto" size="md" linkTo="/" />
        {onClose && (
          // Only meaningful on mobile where the sidebar is an overlay.
          // Hidden on desktop via .sidebar-close-btn (display:none at ≥769px).
          <button
            onClick={onClose}
            aria-label={intl.formatMessage({ id: 'nav.closeNavigation' })}
            className="sidebar-close-btn"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              fontSize: '18px',
              lineHeight: 1,
              padding: '2px 4px',
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Primary nav */}
      <div style={{ padding: '12px 8px 8px', flex: 1 }}>
        <NavGroup>
          {NAV_ITEMS.map((item) => (
            <NavItem key={item.path} {...item} active={isActive(item.path)} onNavigate={onClose} />
          ))}
        </NavGroup>

        <SectionLabel
          collapsible
          open={effectiveAdvancedOpen}
          onToggle={() => setAdvancedOpen((prev) => !prev)}
          controlsId="sidebar-advanced-group"
        >
          {intl.formatMessage({ id: 'nav.advanced' })}
        </SectionLabel>
        {effectiveAdvancedOpen && (
          <NavGroup id="sidebar-advanced-group">
            {ADVANCED_ITEMS.map((item) => (
              <NavItem key={item.path} {...item} active={isActive(item.path)} onNavigate={onClose} />
            ))}
          </NavGroup>
        )}

        {user?.isAdmin && (
          <>
            <SectionLabel>Admin</SectionLabel>
            <NavGroup>
              <NavItem path="/admin" label="Dashboard" icon="⊟" active={isActive('/admin')} onNavigate={onClose} />
            </NavGroup>
          </>
        )}
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
            {intl.formatMessage({ id: 'nav.signOut' })}
          </button>
        </div>
      )}
    </nav>
  );
}

function NavGroup({ children, id }: { children: React.ReactNode; id?: string }) {
  return <div id={id} style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '4px' }}>{children}</div>;
}

function SectionLabel({
  children,
  collapsible,
  open,
  onToggle,
  controlsId,
}: {
  children: React.ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  controlsId?: string;
}) {
  if (collapsible) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open ?? false}
        aria-controls={controlsId}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          width: '100%',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: '10px',
          fontWeight: '600',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--color-text-muted)',
          padding: '12px 8px 4px',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: '10px', transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▸</span>
        {children}
      </button>
    );
  }
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

function NavItem({ path, label, icon, active, onNavigate }: { path: string; label: string; icon: string; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      to={path}
      onClick={onNavigate}
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



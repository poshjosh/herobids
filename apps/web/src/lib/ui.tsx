import React from 'react';
import type { CSSProperties, ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export function PageShell({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      className="page-shell-responsive"
      style={style}
    >
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="page-header-responsive">
      <div>
        <h1 style={{ margin: 0, fontSize: '22px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
          {title}
        </h1>
        {subtitle && (
          <p style={{ margin: '4px 0 0', fontSize: '14px', color: 'var(--color-text-secondary)' }}>
            {subtitle}
          </p>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function Card({
  children,
  style,
  onClick,
}: {
  children: ReactNode;
  style?: CSSProperties;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--color-surface-1)',
        border: '1px solid var(--color-border)',
        borderRadius: '10px',
        padding: '20px',
        cursor: onClick ? 'pointer' : undefined,
        transition: onClick ? 'border-color 0.15s' : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: 'var(--color-success-subtle)', text: 'var(--color-success)', dot: 'var(--color-success)' },
  stopped: { bg: 'var(--color-surface-3)', text: 'var(--color-text-muted)', dot: 'var(--color-text-muted)' },
  crashed: { bg: 'var(--color-danger-subtle)', text: 'var(--color-danger)', dot: 'var(--color-danger)' },
  paused: { bg: 'var(--color-warning-subtle)', text: 'var(--color-warning)', dot: 'var(--color-warning)' },
  starting: { bg: 'var(--color-brand-subtle)', text: 'var(--color-brand)', dot: 'var(--color-brand)' },
};

export function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS['stopped']!;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '3px 8px',
        borderRadius: '20px',
        background: colors.bg,
        color: colors.text,
        fontSize: '12px',
        fontWeight: '500',
      }}
    >
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: colors.dot,
          flexShrink: 0,
        }}
      />
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Severity badge
// ---------------------------------------------------------------------------

const SEVERITY_COLORS: Record<string, { bg: string; text: string }> = {
  info: { bg: 'transparent', text: 'var(--color-text-muted)' },
  warn: { bg: 'var(--color-warning-subtle)', text: 'var(--color-warning)' },
  critical: { bg: 'var(--color-danger-subtle)', text: 'var(--color-danger)' },
};

export function SeverityDot({ severity }: { severity: 'info' | 'warn' | 'critical' }) {
  const colors = SEVERITY_COLORS[severity]!;
  if (severity === 'info') return null;
  return (
    <span
      style={{
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: colors.text,
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

interface ButtonProps {
  children: ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  form?: string;
  style?: CSSProperties;
}

const BUTTON_STYLES: Record<string, CSSProperties> = {
  primary: {
    background: 'var(--color-brand)',
    color: 'white',
    border: '1px solid transparent',
  },
  secondary: {
    background: 'var(--color-surface-2)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
  },
  danger: {
    background: 'var(--color-danger-subtle)',
    color: 'var(--color-danger)',
    border: '1px solid var(--color-danger)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    border: '1px solid transparent',
  },
};

export function Button({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  disabled,
  type = 'button',
  form,
  style,
}: ButtonProps) {
  return (
    <button
      type={type}
      form={form}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        padding: size === 'sm' ? '5px 12px' : '8px 16px',
        fontSize: size === 'sm' ? '12px' : '14px',
        fontWeight: '500',
        borderRadius: '7px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'opacity 0.15s',
        ...BUTTON_STYLES[variant],
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

export function LoadingRows({ count = 3 }: { count?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            height: '72px',
            background: 'var(--color-surface-2)',
            borderRadius: '10px',
            animation: 'pulse 1.5s ease-in-out infinite',
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

export function EmptyState({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '60px 24px',
        textAlign: 'center',
        gap: '12px',
      }}
    >
      <div style={{ fontSize: '32px', opacity: 0.3 }}>◈</div>
      <div style={{ fontSize: '16px', fontWeight: '500', color: 'var(--color-text-primary)' }}>{title}</div>
      <div style={{ fontSize: '14px', color: 'var(--color-text-secondary)', maxWidth: '320px' }}>{message}</div>
      {action && <div style={{ marginTop: '8px' }}>{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      style={{
        padding: '32px',
        background: 'var(--color-danger-subtle)',
        border: '1px solid var(--color-danger)',
        borderRadius: '10px',
        color: 'var(--color-danger)',
      }}
    >
      <div style={{ fontWeight: '500', marginBottom: '4px' }}>Something went wrong</div>
      <div style={{ fontSize: '13px', opacity: 0.8 }}>{message}</div>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            marginTop: '12px',
            padding: '5px 12px',
            background: 'transparent',
            border: '1px solid var(--color-danger)',
            borderRadius: '6px',
            color: 'var(--color-danger)',
            fontSize: '12px',
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section divider label
// ---------------------------------------------------------------------------

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: '11px',
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--color-text-muted)',
        marginBottom: '12px',
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline key-value pair
// ---------------------------------------------------------------------------

export function KV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
      <span style={{ fontSize: '14px', color: 'var(--color-text-primary)', fontWeight: '500' }}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid layout helper
// ---------------------------------------------------------------------------

export function Grid({ children, columns = 3, gap = 16 }: { children: ReactNode; columns?: number; gap?: number }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: `${gap}px`,
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relative time formatting
// ---------------------------------------------------------------------------

export function RelativeTime({ timestamp }: { timestamp: string | null }) {
  if (!timestamp) return <span style={{ color: 'var(--color-text-muted)' }}>—</span>;

  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = Math.floor((now - then) / 1000);

  let label: string;
  if (diff < 60) label = `${diff}s ago`;
  else if (diff < 3600) label = `${Math.floor(diff / 60)}m ago`;
  else if (diff < 86400) label = `${Math.floor(diff / 3600)}h ago`;
  else label = `${Math.floor(diff / 86400)}d ago`;

  return (
    <span style={{ color: 'var(--color-text-muted)', fontSize: '12px' }} title={timestamp}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Form helpers (also used by SettingsPage and other features)
// ---------------------------------------------------------------------------

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '12px', fontWeight: '500', color: 'var(--color-text-secondary)', marginBottom: '6px' }}>
      {children}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: '10px 14px',
        background: 'var(--color-danger-subtle)',
        border: '1px solid var(--color-danger)',
        borderRadius: '7px',
        color: 'var(--color-danger)',
        fontSize: '13px',
        marginBottom: '16px',
      }}
    >
      {message}
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: '7px',
  color: 'var(--color-text-primary)',
  fontSize: '14px',
  outline: 'none',
  boxSizing: 'border-box',
};

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        zIndex: 50,
        padding: '24px',
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-surface-1)',
          border: '1px solid var(--color-border)',
          borderRadius: '12px',
          padding: '28px',
          width: '100%',
          maxWidth: '480px',
          maxHeight: 'calc(100vh - 48px)',
          overflowY: 'auto',
          margin: 'auto 0',
        }}
      >
        <div style={{ fontWeight: '600', fontSize: '17px', marginBottom: '24px' }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

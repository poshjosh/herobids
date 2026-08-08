import React, { useMemo, useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode } from 'react';
import { useIntl } from 'react-intl';

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
  className,
}: {
  children: ReactNode;
  style?: CSSProperties;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <div
      className={className}
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

export function MetricCard({ label, value, total, color, className }: { label: string; value: string | number; total?: number; color?: string; className?: string }) {
  return (
    <Card className={className} style={{ padding: '16px 20px' }}>
      <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
        {label}
      </div>
      <div style={{ fontSize: '24px', fontWeight: '600', color: color ?? 'var(--color-text-primary)' }}>
        {value}
        {total !== undefined && (
          <span style={{ fontSize: '14px', fontWeight: '400', color: 'var(--color-text-muted)', marginLeft: '4px' }}>
            / {total}
          </span>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  active: { bg: 'var(--color-success-subtle)', text: 'var(--color-success)', dot: 'var(--color-success)' },
  running: { bg: 'var(--color-success-subtle)', text: 'var(--color-success)', dot: 'var(--color-success)' },
  stopped: { bg: 'var(--color-surface-3)', text: 'var(--color-text-muted)', dot: 'var(--color-text-muted)' },
  crashed: { bg: 'var(--color-danger-subtle)', text: 'var(--color-danger)', dot: 'var(--color-danger)' },
  unhealthy: { bg: 'var(--color-warning-subtle)', text: 'var(--color-warning)', dot: 'var(--color-warning)' },
  paused: { bg: 'var(--color-warning-subtle)', text: 'var(--color-warning)', dot: 'var(--color-warning)' },
  starting: { bg: 'var(--color-brand-subtle)', text: 'var(--color-brand)', dot: 'var(--color-brand)' },
};

// Statuses that represent a live/running state — dot gets a pulse animation
const LIVE_STATUSES = new Set(['active', 'running', 'starting']);

export function StatusBadge({ status }: { status: string }) {
  const intl = useIntl();
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS['stopped']!;
  const label = intl.formatMessage({ id: `status.${status}`, defaultMessage: status });
  const isLive = LIVE_STATUSES.has(status);
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
          ...(isLive ? { animation: 'status-dot-pulse 1.8s ease-in-out infinite' } : {}),
        }}
      />
      {label}
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

interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'style'> {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
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
  variant = 'secondary',
  size = 'md',
  disabled,
  style,
  ...rest
}: ButtonProps) {
  return (
    <button
      disabled={disabled}
      {...rest}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        padding: size === 'sm' ? '5px 12px' : '8px 16px',
        fontSize: size === 'sm' ? '13px' : '15px',
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
  const intl = useIntl();
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
      <div style={{ fontWeight: '500', marginBottom: '4px' }}>
        {intl.formatMessage({ id: 'common.errorTitle' })}
      </div>
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
          {intl.formatMessage({ id: 'common.retry' })}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section divider label
// ---------------------------------------------------------------------------

export function SectionLabel({ children, uppercase = true }: { children: ReactNode; uppercase?: boolean }) {
  return (
    <div
      style={{
        fontSize: '11px',
        fontWeight: '600',
        textTransform: uppercase ? 'uppercase' : 'none',
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
  const intl = useIntl();

  if (!timestamp) return <span style={{ color: 'var(--color-text-muted)' }}>—</span>;

  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffSeconds = Math.floor((now - then) / 1000);

  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;

  if (diffSeconds < 60) {
    value = -diffSeconds;
    unit = 'second';
  } else if (diffSeconds < 3600) {
    value = -Math.floor(diffSeconds / 60);
    unit = 'minute';
  } else if (diffSeconds < 86400) {
    value = -Math.floor(diffSeconds / 3600);
    unit = 'hour';
  } else {
    value = -Math.floor(diffSeconds / 86400);
    unit = 'day';
  }

  const label = intl.formatRelativeTime(value, unit, { numeric: 'always', style: 'short' });

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
    <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--color-text-primary)', marginBottom: '8px', letterSpacing: '0.02em' }}>
      {children}
    </div>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
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
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
      }}
    >
      <span style={{ flex: 1 }}>{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-danger)',
            cursor: 'pointer',
            fontSize: '16px',
            lineHeight: 1,
            padding: '0 2px',
            opacity: 0.7,
          }}
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  background: 'var(--color-surface-3)',
  border: '1.5px solid var(--input-border-color)',
  borderRadius: '8px',
  color: 'var(--color-text-primary)',
  fontSize: '15px',
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s, box-shadow 0.15s',
};

export function Modal({
  title,
  onClose,
  closeOnBackdropClick = true,
  placement = 'center',
  maxWidth = '480px',
  children,
}: {
  title: string;
  onClose: () => void;
  closeOnBackdropClick?: boolean;
  placement?: 'center' | 'top';
  maxWidth?: string;
  children: React.ReactNode;
}) {
  const content = (
    <div
      onClick={closeOnBackdropClick ? onClose : undefined}
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
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-surface-1)',
          border: '1px solid var(--color-border)',
          borderRadius: '12px',
          padding: '28px',
          width: '100%',
          maxWidth,
          maxHeight: placement === 'top' ? 'calc(100vh - 96px)' : 'calc(100vh - 48px)',
          overflowY: 'auto',
          margin: placement === 'top' ? '24px 0' : 'auto 0',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <div style={{ fontWeight: '600', fontSize: '17px' }}>{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '4px',
              color: 'var(--color-text-muted)',
              fontSize: '18px',
              lineHeight: '1',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );

  // In SSR (e.g. renderToStaticMarkup), portals to document.body are not available.
  // Render the content directly without a portal.
  if (typeof document === 'undefined') {
    return content;
  }

  return createPortal(content, document.body);
}

// ---------------------------------------------------------------------------
// ToolTagPicker — combobox multi-select for agent tool names
// ---------------------------------------------------------------------------

export interface ToolTagPickerProps {
  tools: { name: string; category: string; description: string }[];
  categories: { name: string; label: string; count: number }[];
  value: string[];
  onChange: (tools: string[]) => void;
  disabled?: boolean;
  loading?: boolean;
  /** Label for the trigger button. Default: "+ Add tools..." */
  addToolsLabel?: string;
  /** Placeholder text for the search input. Default: "Search tools..." */
  searchPlaceholder?: string;
  /** Message shown when the tools list is empty. Default: "No tools available." */
  noToolsAvailableLabel?: string;
  /** Template for the no-search-results message. Use '{query}' as placeholder. Default: "No tools match '{query}'" */
  noMatchLabel?: string;
}

export function ToolTagPicker({
  tools,
  categories,
  value,
  onChange,
  disabled = false,
  loading = false,
  addToolsLabel = '+ Add tools...',
  searchPlaceholder = 'Search tools...',
  noToolsAvailableLabel = 'No tools available.',
  noMatchLabel = "No tools match '{query}'",
}: ToolTagPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(value), [value]);

  // Reset highlighted index when filtered results change
  useEffect(() => {
    setHighlightedIndex(0);
  }, [searchQuery]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (ev: MouseEvent) => {
      const target = ev.target;
      if (target instanceof Node && containerRef.current && !containerRef.current.contains(target)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setIsOpen(false);
        setSearchQuery('');
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen]);

  // Sort tool names by category order then alphabetically within category
  const sortTools = (toolNames: string[]): string[] => {
    const categoryOrder = categories.map((c) => c.name);
    const getCategory = (name: string) => {
      const tool = tools.find((t) => t.name === name);
      return tool?.category ?? '';
    };
    return [...toolNames].sort((a, b) => {
      const catA = categoryOrder.indexOf(getCategory(a));
      const catB = categoryOrder.indexOf(getCategory(b));
      if (catA !== catB) return (catA === -1 ? 999 : catA) - (catB === -1 ? 999 : catB);
      return a.localeCompare(b);
    });
  };

  const toggleTool = (toolName: string) => {
    if (selectedSet.has(toolName)) {
      onChange(sortTools(value.filter((t) => t !== toolName)));
    } else {
      onChange(sortTools([...value, toolName]));
    }
  };

  const removeTool = (toolName: string) => {
    onChange(sortTools(value.filter((t) => t !== toolName)));
  };

  // Filter tools by search query
  const filteredTools = searchQuery.trim()
    ? tools.filter(
        (t) =>
          t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          t.description.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : tools;

  // Group filtered tools by category, preserving category order from the categories prop
  const categoryOrder = categories.map((c) => c.name);
  const grouped = new Map<string, typeof tools>();
  for (const tool of filteredTools) {
    const group = grouped.get(tool.category) ?? [];
    group.push(tool);
    grouped.set(tool.category, group);
  }
  // Sort groups by categoryOrder, then alphabetically within group
  const sortedGroups = Array.from(grouped.entries()).sort((a, b) => {
    const ai = categoryOrder.indexOf(a[0]);
    const bi = categoryOrder.indexOf(b[0]);
    if (ai === -1 && bi === -1) return a[0].localeCompare(b[0]);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const categoryLabelMap = new Map(categories.map((c) => [c.name, c.label]));

  // Flat list for keyboard navigation
  const flatToolList = sortedGroups.flatMap(([, groupTools]) => groupTools);

  const handleDropdownKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((prev) => Math.min(prev + 1, flatToolList.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((prev) => Math.max(prev - 1, 0));
    } else if (event.key === 'Enter' && flatToolList.length > 0) {
      event.preventDefault();
      const tool = flatToolList[Math.min(highlightedIndex, flatToolList.length - 1)];
      if (tool) toggleTool(tool.name);
    }
  };

  // Loading state
  if (loading) {
    return (
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ ...SKELETON_PILL_STYLE, width: '120px' }} />
        <div style={{ ...SKELETON_PILL_STYLE, width: '90px' }} />
        <div style={{ ...SKELETON_PILL_STYLE, width: '100px' }} />
      </div>
    );
  }

  // Empty state (no tools data)
  if (tools.length === 0) {
    return (
      <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{noToolsAvailableLabel}</div>
    );
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* Selected pills + trigger */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
        {value.map((toolName) => (
          <span
            key={toolName}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '3px 8px',
              borderRadius: '20px',
              background: 'var(--color-accent-subtle, rgba(99,102,241,0.1))',
              border: '1px solid var(--color-accent)',
              fontSize: '12px',
              color: 'var(--color-accent)',
              lineHeight: '1.4',
            }}
          >
            {toolName}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                removeTool(toolName);
              }}
              disabled={disabled}
              style={{
                background: 'none',
                border: 'none',
                color: 'inherit',
                cursor: disabled ? 'default' : 'pointer',
                fontSize: '14px',
                lineHeight: 1,
                padding: '0 2px',
                opacity: 0.7,
              }}
              aria-label={`Remove ${toolName}`}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          disabled={disabled}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '3px 10px',
            borderRadius: '20px',
            background: 'var(--color-surface-2)',
            border: '1px dashed var(--color-border)',
            fontSize: '12px',
            color: 'var(--color-text-secondary)',
            cursor: disabled ? 'default' : 'pointer',
            lineHeight: '1.4',
          }}
        >
          {addToolsLabel}
        </button>
      </div>

      {/* Dropdown */}
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 100,
            background: 'var(--color-surface-1)',
            border: '1px solid var(--color-border)',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
            maxHeight: '360px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Search input */}
          <div style={{ padding: '8px', borderBottom: '1px solid var(--color-border)' }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={searchPlaceholder}
              autoFocus
              style={{ ...inputStyle, padding: '6px 10px', borderRadius: '6px', fontSize: '13px' }}
              onKeyDown={handleDropdownKeyDown}
            />
          </div>

          {/* Tool list */}
          <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
            {sortedGroups.length === 0 ? (
              <div style={{ padding: '16px', textAlign: 'center', fontSize: '13px', color: 'var(--color-text-muted)' }}>
                {noMatchLabel.replace('{query}', searchQuery)}
              </div>
            ) : (
              sortedGroups.map(([category, groupTools]) => (
                <div key={category}>
                  <div
                    style={{
                      padding: '6px 12px 2px',
                      fontSize: '11px',
                      fontWeight: '600',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    {categoryLabelMap.get(category) ?? category} ({groupTools.length})
                  </div>
                  {groupTools.map((tool) => {
                    const isSelected = selectedSet.has(tool.name);
                    const globalIdx = flatToolList.indexOf(tool);
                    const isHighlighted = globalIdx === highlightedIndex;
                    return (
                      <button
                        key={tool.name}
                        type="button"
                        onClick={() => toggleTool(tool.name)}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '8px',
                          width: '100%',
                          padding: '6px 12px',
                          background: isSelected
                            ? 'var(--color-accent-subtle, rgba(99,102,241,0.08))'
                            : isHighlighted
                              ? 'var(--color-surface-2)'
                              : 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontSize: '13px',
                          color: 'var(--color-text-primary)',
                        }}
                      >
                        <span style={{ flexShrink: 0, width: '16px', fontSize: '13px', lineHeight: '1.4' }}>
                          {isSelected ? '✓' : '○'}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: '500', fontSize: '13px' }}>{tool.name}</div>
                          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', lineHeight: '1.4', marginTop: '1px' }}>
                            {tool.description}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const SKELETON_PILL_STYLE: React.CSSProperties = {
  height: '26px',
  borderRadius: '20px',
  background: 'var(--color-surface-2)',
  opacity: 0.5,
};

import { useState } from 'react';
import { useIntl } from 'react-intl';
import type { AgentActivityEntry, AgentActivityCategory, AgentActivitySeverity } from '../../lib/api-client.js';
import { RelativeTime } from '../../lib/ui.js';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Category → icon mapping
// ---------------------------------------------------------------------------

const CATEGORY_ICONS: Record<AgentActivityCategory, string> = {
  runtime: '⟳',
  decision: '◈',
  tool: '⚙',
  tick: '⏱',
  message: '✉',
  artifact: '📄',
  risk: '⚠',
  system: '⊡',
};

const SEVERITY_COLORS: Record<AgentActivitySeverity, string> = {
  info: 'var(--color-text-muted)',
  warn: 'var(--color-warning)',
  critical: 'var(--color-danger)',
};

export function formatDetailValue(value: unknown, key?: string): ReactNode {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return (
      <div
        style={{
          paddingLeft: '10px',
          borderLeft: '2px solid var(--color-border-subtle)',
          marginTop: '2px',
        }}
      >
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <DetailRow key={k} label={k} value={formatDetailValue(v, k)} />
        ))}
      </div>
    );
  }
  if (Array.isArray(value)) {
    const hasStructuredItems = value.some((item) => typeof item === 'object' && item !== null);
    if (!hasStructuredItems) {
      return value.map((item) => String(item)).join(', ');
    }
    return (
      <div
        style={{
          paddingLeft: '10px',
          borderLeft: '2px solid var(--color-border-subtle)',
          marginTop: '2px',
        }}
      >
        {value.map((item, index) => (
          <DetailRow key={index} label={`[${index}]`} value={formatDetailValue(item)} />
        ))}
      </div>
    );
  }
  const str = String(value);
  const isErrorValue = (key === 'finishReason' && str === 'error') || key === 'errorMessage';
  if (isErrorValue) {
    return (
      <span style={{ color: 'var(--color-danger)', fontWeight: 500 }}>
        {str}
      </span>
    );
  }
  return str;
}

export function AgentActivityDetailFields({ entry }: { entry: AgentActivityEntry }) {
  return (
    <>
      <DetailRow label="Event Type" value={entry.eventType} />
      <DetailRow label="Category" value={entry.category} />
      {entry.sessionId && <DetailRow label="Session" value={entry.sessionId.slice(0, 8)} />}
      {entry.correlationId && <DetailRow label="Correlation ID" value={entry.correlationId.slice(0, 12)} />}
      {entry.traceId && <DetailRow label="Trace ID" value={entry.traceId.slice(0, 12)} />}
      {entry.direction && <DetailRow label="Direction" value={entry.direction} />}
      {entry.processingStatus && <DetailRow label="Status" value={entry.processingStatus} />}
      {Object.entries(entry.detail).map(([key, value]) => (
        <DetailRow key={key} label={key} value={formatDetailValue(value, key)} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Timeline row component
// ---------------------------------------------------------------------------

interface TimelineRowProps {
  entry: AgentActivityEntry;
  isLast: boolean;
}

function TimelineRow({ entry, isLast }: TimelineRowProps) {
  const [expanded, setExpanded] = useState(false);
  const icon = CATEGORY_ICONS[entry.category] ?? '·';
  const iconColor = SEVERITY_COLORS[entry.severity] ?? SEVERITY_COLORS.info;

  return (
    <div
      style={{
        borderBottom: isLast ? 'none' : '1px solid var(--color-border-subtle)',
        padding: '12px 16px',
      }}
    >
      {/* Collapsed: time, severity icon, title, summary, More */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '12px',
          cursor: 'pointer',
        }}
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded(!expanded); }}
      >
        {/* Icon */}
        <div
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            background: 'var(--color-surface-2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '12px',
            color: iconColor,
            flexShrink: 0,
            marginTop: '1px',
          }}
        >
          {icon}
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.title}
            </span>
            <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', flexShrink: 0 }}>
              <RelativeTime timestamp={entry.timestamp} />
            </span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '2px', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {entry.summary}
          </div>
        </div>

        {/* More affordance */}
        <div
          style={{
            fontSize: '11px',
            color: 'var(--color-text-muted)',
            flexShrink: 0,
            marginTop: '4px',
          }}
        >
          {expanded ? '▾' : '▸'}
        </div>
      </div>

      {/* Expanded: operator debugging details */}
      {expanded && (
        <div
          style={{
            marginTop: '10px',
            marginLeft: '40px',
            padding: '10px 12px',
            background: 'var(--color-surface-2)',
            borderRadius: '6px',
            fontSize: '12px',
            color: 'var(--color-text-secondary)',
            lineHeight: 1.5,
          }}
        >
          <AgentActivityDetailFields entry={entry} />
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '8px', padding: '2px 0' }}>
      <span style={{ fontWeight: 500, minWidth: '110px', color: 'var(--color-text-muted)', flexShrink: 0 }}>{label}</span>
      <div style={{ wordBreak: 'break-all', minWidth: 0, flex: 1 }}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Timeline Component
// ---------------------------------------------------------------------------

interface AgentActivityTimelineProps {
  entries: AgentActivityEntry[];
  isLoading: boolean;
  isEmpty: boolean;
}

export function AgentActivityTimeline({ entries, isLoading, isEmpty }: AgentActivityTimelineProps) {
  const intl = useIntl();

  if (isLoading) {
    return (
      <div style={{ padding: '20px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
        {intl.formatMessage({ id: 'common.loading', defaultMessage: 'Loading…' })}
      </div>
    );
  }

  if (isEmpty) {
    return (
      <p style={{ color: 'var(--color-text-muted)', fontSize: '13px', padding: '0 16px' }}>
        {intl.formatMessage({ id: 'agents.detail.noActivityFeed', defaultMessage: 'No activity recorded yet.' })}
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {entries.map((entry, i) => (
        <TimelineRow key={entry.id} entry={entry} isLast={i === entries.length - 1} />
      ))}
    </div>
  );
}

import type { ActivityEvent } from '../../lib/api-client.js';
import { RelativeTime } from '../../lib/ui.js';

const CATEGORY_ICONS: Record<string, string> = {
  decision: '◈',
  execution: '↗',
  risk: '⚠',
  system: '⊡',
};

const CATEGORY_COLORS: Record<string, string> = {
  decision: 'var(--color-brand)',
  execution: 'var(--color-success)',
  risk: 'var(--color-warning)',
  system: 'var(--color-text-muted)',
};

interface TimelineEventProps {
  event: ActivityEvent;
  isLast?: boolean;
}

export function TimelineEvent({ event, isLast = false }: TimelineEventProps) {
  const [expanded, setExpanded] = useState(false);
  const icon = CATEGORY_ICONS[event.category] ?? '·';
  const dotColor = CATEGORY_COLORS[event.category] ?? 'var(--color-text-muted)';

  const hasDetail = Object.keys(event.detail).length > 0;

  return (
    <div style={{ display: 'flex', gap: '12px', position: 'relative' }}>
      {/* Timeline line */}
      {!isLast && (
        <div
          style={{
            position: 'absolute',
            left: '13px',
            top: '28px',
            bottom: '-12px',
            width: '2px',
            background: 'var(--color-border-subtle)',
          }}
        />
      )}

      {/* Dot */}
      <div
        style={{
          width: '28px',
          height: '28px',
          borderRadius: '50%',
          background: 'var(--color-surface-2)',
          border: `2px solid var(--color-border)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '11px',
          color: dotColor,
          flexShrink: 0,
          zIndex: 1,
        }}
      >
        {icon}
      </div>

      {/* Content */}
      <div style={{ flex: 1, paddingBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
          <span style={{ fontSize: '13px', color: 'var(--color-text-primary)', fontWeight: '500' }}>
            {event.message}
          </span>
          {event.severity !== 'info' && (
            <span
              style={{
                fontSize: '10px',
                padding: '1px 6px',
                borderRadius: '4px',
                background: event.severity === 'critical' ? 'var(--color-danger-subtle)' : 'var(--color-warning-subtle)',
                color: event.severity === 'critical' ? 'var(--color-danger)' : 'var(--color-warning)',
              }}
            >
              {event.severity}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <RelativeTime timestamp={event.timestamp} />
          {hasDetail && (
            <button
              onClick={() => setExpanded(!expanded)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--color-text-muted)',
                fontSize: '11px',
                cursor: 'pointer',
                padding: '0',
              }}
            >
              {expanded ? 'hide detail ↑' : 'show detail ↓'}
            </button>
          )}
        </div>
        {expanded && hasDetail && (
          <pre
            style={{
              marginTop: '8px',
              padding: '10px 12px',
              background: 'var(--color-surface-2)',
              borderRadius: '6px',
              fontSize: '11px',
              color: 'var(--color-text-secondary)',
              overflow: 'auto',
              maxHeight: '200px',
            }}
          >
            {JSON.stringify(event.detail, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

// useState is needed — import here
import { useState } from 'react';

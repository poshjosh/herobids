import type { ActivityEvent } from '../../lib/api-client.js';
import { RelativeTime } from '../../lib/ui.js';

const CATEGORY_ICONS: Record<string, string> = {
  decision: '◈',
  execution: '↗',
  risk: '⚠',
  system: '⊡',
};

const SEVERITY_COLORS: Record<string, string> = {
  info: 'var(--color-text-muted)',
  warn: 'var(--color-warning)',
  critical: 'var(--color-danger)',
};

interface ActivityItemProps {
  event: ActivityEvent;
  isLast?: boolean;
}

export function ActivityItem({ event, isLast = false }: ActivityItemProps) {
  const icon = CATEGORY_ICONS[event.category] ?? '·';
  const iconColor = SEVERITY_COLORS[event.severity] ?? SEVERITY_COLORS['info']!;

  return (
    <div
      style={{
        display: 'flex',
        gap: '12px',
        padding: '12px 20px',
        borderBottom: isLast ? 'none' : '1px solid var(--color-border-subtle)',
        transition: 'background 0.1s',
      }}
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
        <div style={{ fontSize: '13px', color: 'var(--color-text-primary)', lineHeight: 1.4 }}>
          {event.message}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
          <RelativeTime timestamp={event.timestamp} />
        </div>
      </div>
    </div>
  );
}

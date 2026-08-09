import { useIntl } from 'react-intl';
import type { ActivityEvent } from '../../lib/api-client.js';
import { RelativeTime } from '../../lib/ui.js';
import { toMessageValues } from '../../lib/localize-api-error.js';

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
  const intl = useIntl();
  const icon = CATEGORY_ICONS[event.category] ?? '·';
  const iconColor = SEVERITY_COLORS[event.severity] ?? SEVERITY_COLORS['info']!;

  // Translate the event message from its key + detail params.
  // Only primitive values from detail are safe for ICU interpolation.
  // Falls back to the raw event type for unknown event keys.
  const messageText = intl.formatMessage(
    { id: event.messageKey, defaultMessage: event.type },
    toMessageValues(event.detail),
  );

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
          fontSize: '0.75rem',
          color: iconColor,
          flexShrink: 0,
          marginTop: '1px',
        }}
      >
        {icon}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-primary)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', wordBreak: 'break-word' }}>
          {messageText}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
          <RelativeTime timestamp={event.timestamp} />
        </div>
      </div>
    </div>
  );
}

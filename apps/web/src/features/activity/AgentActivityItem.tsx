import type { AgentActivityEntry, AgentActivityCategory, AgentActivitySeverity } from '../../lib/api-client.js';
import { RelativeTime } from '../../lib/ui.js';

// ---------------------------------------------------------------------------
// Category → icon mapping (matches timeline but compact for sidebar/feed)
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

interface AgentActivityItemProps {
  entry: AgentActivityEntry & { agentName?: string | null };
  isLast?: boolean;
}

export function AgentActivityItem({ entry, isLast = false }: AgentActivityItemProps) {
  const icon = CATEGORY_ICONS[entry.category] ?? '·';
  const iconColor = SEVERITY_COLORS[entry.severity] ?? SEVERITY_COLORS.info;

  return (
    <div
      style={{
        display: 'flex',
        gap: '12px',
        padding: '12px 20px',
        borderBottom: isLast ? 'none' : '1px solid var(--color-border-subtle)',
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {entry.title}
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', flexShrink: 0 }}>
            <RelativeTime timestamp={entry.timestamp} />
          </span>
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: '2px', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {entry.summary}
        </div>
        {entry.agentName && (
          <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)', marginTop: '3px' }}>
            Agent: {entry.agentName}
          </div>
        )}
      </div>
    </div>
  );
}

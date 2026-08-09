import type { BotSummary } from '../../lib/api-client.js';

interface HealthStripProps {
  instances: BotSummary[];
}

export function HealthStrip({ instances }: HealthStripProps) {
  const running = instances.filter((i) => i.status === 'running');
  const crashed = instances.filter((i) => i.status === 'crashed');
  const stopped = instances.filter((i) => i.status === 'stopped');

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '20px',
        padding: '10px 16px',
        background: 'var(--color-surface-1)',
        border: '1px solid var(--color-border)',
        borderRadius: '8px',
        marginBottom: '24px',
        flexWrap: 'wrap',
      }}
    >
      <HealthItem
        label="Running"
        count={running.length}
        color="var(--color-success)"
        dotColor="var(--color-success)"
      />
      {stopped.length > 0 && (
        <HealthItem
          label="Paused"
          count={stopped.length}
          color="var(--color-text-muted)"
          dotColor="var(--color-text-muted)"
        />
      )}
      {crashed.length > 0 && (
        <HealthItem
          label="Crashed"
          count={crashed.length}
          color="var(--color-danger)"
          dotColor="var(--color-danger)"
          attention
        />
      )}

      {instances.length === 0 && (
        <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
          No agents configured
        </span>
      )}
    </div>
  );
}

function HealthItem({
  label,
  count,
  color,
  dotColor,
  attention,
}: {
  label: string;
  count: number;
  color: string;
  dotColor: string;
  attention?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: dotColor,
          flexShrink: 0,
          animation: attention ? 'pulse 1.5s ease-in-out infinite' : undefined,
        }}
      />
      <span style={{ fontSize: '0.8125rem', color }}>
        {count} {label}
      </span>
    </div>
  );
}

import type { AdminCapacityResponse } from '../../lib/api-client.js';
import { Card } from '../../lib/ui.js';
import { nodesBarColor, nodesUsedPct } from './capacity-display.js';

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>{label}</span>
      <span style={{ fontSize: '1.125rem', fontWeight: '600', color: 'var(--color-text-primary)' }}>{value}</span>
      {sub && <span style={{ fontSize: '0.625rem', color: 'var(--color-text-muted)' }}>{sub}</span>}
    </div>
  );
}

/** Nodes-vs-max bar: warns as the cluster approaches the scale-out ceiling. */
function NodesBar({ ready, max }: { ready: number; max: number }) {
  const pct = nodesUsedPct(ready, max);
  const color = nodesBarColor(ready, max);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6875rem', color: 'var(--color-text-muted)', marginBottom: '3px' }}>
        <span>Agent nodes</span>
        <span>{ready} / {max}</span>
      </div>
      <div style={{ height: '4px', background: 'var(--color-surface-3)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '2px' }} />
      </div>
    </div>
  );
}

function fmtMemoryMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export function AdminCapacitySection({ data }: { data: AdminCapacityResponse }) {
  const capacity = data.capacity;

  if (!capacity) {
    return (
      <Card>
        <div style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem', padding: '8px 0' }}>
          Capacity not reporting. This is expected when the agent runtime backend is not Nomad.
        </div>
      </Card>
    );
  }

  const atCeiling = capacity.readyAgentNodes >= capacity.maxAgentNodes && capacity.maxAgentNodes > 0;

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <NodesBar ready={capacity.readyAgentNodes} max={capacity.maxAgentNodes} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '16px' }}>
        <StatTile
          label="Free slots"
          value={String(capacity.freeSlots)}
          sub={`${fmtMemoryMb(capacity.agentMemoryReservationMb)}/slot`}
        />
        <StatTile
          label="Free memory"
          value={fmtMemoryMb(capacity.freeMemoryMb)}
          sub={`of ${fmtMemoryMb(capacity.totalMemoryMb)}`}
        />
        <StatTile label="Ready nodes" value={String(capacity.readyAgentNodes)} />
        <StatTile label="Max nodes" value={String(capacity.maxAgentNodes)} />
      </div>

      {atCeiling && (
        <div style={{ fontSize: '0.75rem', color: 'var(--color-warning)' }}>
          At the configured node ceiling — no further scale-out until the limit is raised.
        </div>
      )}

      <div style={{ fontSize: '0.625rem', color: 'var(--color-text-muted)' }}>
        Max nodes mirrors operator config; the enforced ceiling lives in infrastructure.
      </div>
    </Card>
  );
}

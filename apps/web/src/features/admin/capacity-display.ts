/** Utilization thresholds (percent) shared by the admin usage bars. */
export const USAGE_WARNING_PCT = 65;
export const USAGE_DANGER_PCT = 85;

/** Nodes-vs-ceiling thresholds: warn as the pool approaches max, danger at/over it. */
export const NODES_WARNING_PCT = 80;
export const NODES_DANGER_PCT = 100;

/** Percent of the node ceiling in use (0-100), or 0 when no ceiling is configured. */
export function nodesUsedPct(ready: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(Math.round((ready / max) * 100), 100);
}

/** Bar colour for the nodes-vs-max gauge. */
export function nodesBarColor(ready: number, max: number): string {
  const pct = nodesUsedPct(ready, max);
  if (pct >= NODES_DANGER_PCT) return 'var(--color-danger)';
  if (pct >= NODES_WARNING_PCT) return 'var(--color-warning)';
  return 'var(--color-success)';
}

import type { AdminMarketDataOverview, AdminProviderRow } from '../../lib/api-client.js';
import { Card, Grid, KV, EmptyState } from '../../lib/ui.js';

interface Props {
  overview: AdminMarketDataOverview | null;
  providers: AdminProviderRow[];
}

function FreshnessBadge({ state }: { state: string }) {
  const color =
    state === 'fresh'
      ? 'var(--color-success)'
      : state === 'stale'
        ? 'var(--color-warning)'
        : 'var(--color-text-muted)';
  const bg =
    state === 'fresh'
      ? 'var(--color-success-subtle)'
      : state === 'stale'
        ? 'var(--color-warning-subtle)'
        : 'var(--color-surface-3)';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '20px',
        fontSize: '0.75rem',
        fontWeight: '500',
        color,
        background: bg,
      }}
    >
      {state}
    </span>
  );
}

function PassBadge({ pass }: { pass: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '20px',
        fontSize: '0.75rem',
        fontWeight: '500',
        color: pass ? 'var(--color-success)' : 'var(--color-danger)',
        background: pass ? 'var(--color-success-subtle)' : 'var(--color-danger-subtle)',
      }}
    >
      {pass ? 'pass' : 'fail'}
    </span>
  );
}

function fmtTs(ts: string | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export function AdminMarketDataSection({ overview, providers }: Props) {
  const disc = overview?.discovery ?? null;
  const lastError = overview?.lastError ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Discovery health card */}
      <Card>
        <div style={{ fontWeight: '600', marginBottom: '12px' }}>Discovery Snapshot</div>
        {disc == null ? (
          <div style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>No discovery snapshot available</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <Grid columns={4} gap={12}>
              <KV
                label="Freshness"
                value={
                  <FreshnessBadge
                    state={
                      disc.sourceStats?.['discovery']?.freshness ??
                      (disc.snapshotId ? 'fresh' : 'unavailable')
                    }
                  />
                }
              />
              <KV label="Captured At" value={fmtTs(disc.capturedAt)} />
              <KV label="Next Poll" value={fmtTs(disc.nextPollDueAt)} />
              <KV label="Token Count" value={disc.tokenCount.toLocaleString()} />
            </Grid>

            {/* Network breakdown */}
            {disc.sourceStats?.['discovery']?.networkCounts &&
              Object.keys(disc.sourceStats['discovery'].networkCounts).length > 0 && (
                <div>
                  <div style={{ fontSize: '0.6875rem', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)', marginBottom: '6px' }}>
                    Tokens by Network
                  </div>
                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    {Object.entries(disc.sourceStats['discovery'].networkCounts).map(([network, count]) => (
                      <div
                        key={network}
                        style={{
                          padding: '4px 10px',
                          borderRadius: '6px',
                          background: 'var(--color-surface-2)',
                          fontSize: '0.75rem',
                          color: 'var(--color-text-primary)',
                        }}
                      >
                        <span style={{ color: 'var(--color-text-muted)' }}>{network}: </span>
                        <span style={{ fontWeight: '600' }}>{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            {/* Source contribution */}
            {disc.sourceStats && Object.keys(disc.sourceStats).length > 0 && (
              <div>
                <div style={{ fontSize: '0.6875rem', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)', marginBottom: '6px' }}>
                  Discovery Source Contribution
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {Object.entries(disc.sourceStats).map(([src, info]) => (
                    <div
                      key={src}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '4px 10px',
                        borderRadius: '6px',
                        background: 'var(--color-surface-2)',
                        fontSize: '0.75rem',
                      }}
                    >
                      <span style={{ color: 'var(--color-text-muted)' }}>{src}</span>
                      <FreshnessBadge state={String(info.freshness)} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Latest error */}
      {lastError && (
        <Card style={{ borderColor: 'var(--color-warning)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <div style={{ fontWeight: '600' }}>Latest Market Data Error</div>
            <span style={{ background: 'var(--color-warning-subtle)', color: 'var(--color-warning)', padding: '2px 8px', borderRadius: '20px', fontSize: '0.6875rem', fontWeight: '600' }}>
              {lastError.source}
            </span>
          </div>
          <KV label="Occurred At" value={fmtTs(lastError.occurredAt)} />
          {lastError.benchmarkSymbol && <KV label="Benchmark" value={lastError.benchmarkSymbol} />}
        </Card>
      )}

      {/* Regime snapshots */}
      {overview && Object.keys(overview.regimeSnapshots).length > 0 && (
        <Card>
          <div style={{ fontWeight: '600', marginBottom: '12px' }}>Regime Snapshots</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {Object.entries(overview.regimeSnapshots).map(([symbol, snap]) => (
              <div
                key={symbol}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '10px 14px',
                  background: 'var(--color-surface-2)',
                  borderRadius: '8px',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontWeight: '600', minWidth: '60px' }}>{symbol}</span>
                {snap == null ? (
                  <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>No snapshot</span>
                ) : (
                  <>
                    <PassBadge pass={snap.pass} />
                    <FreshnessBadge state={snap.freshness.state} />
                    <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                      {fmtTs(snap.evaluatedAt)}
                    </span>
                    {snap.reasons.length > 0 && (
                      <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', flex: 1 }}>
                        {snap.reasons.join(' · ')}
                      </span>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Providers table */}
      <Card style={{ padding: 0 }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border-subtle)' }}>
          <span style={{ fontSize: '0.875rem', fontWeight: '600', color: 'var(--color-text-primary)' }}>
            Providers
          </span>
        </div>

        {providers.length === 0 ? (
          <EmptyState title="No provider data" message="Market data config not available." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
              <thead>
                <tr style={{ background: 'var(--color-surface-2)' }}>
                  <Th>Provider</Th>
                  <Th>Status</Th>
                  <Th>Request Class</Th>
                  <Th>RPM</Th>
                  <Th>Burst</Th>
                  <Th>Max Wait</Th>
                  <Th>Cache TTL</Th>
                  <Th>Success</Th>
                  <Th>Failure</Th>
                  <Th>Last Success</Th>
                  <Th>Fresh</Th>
                  <Th>Cached</Th>
                  <Th>Waits</Th>
                  <Th>Throttles</Th>
                </tr>
              </thead>
              <tbody>
                {providers.flatMap((p) =>
                  p.requestClasses.map((rc, idx) => (
                    <tr key={`${p.name}-${rc.requestClass}`} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                      {idx === 0 && (
                        <Td rowSpan={p.requestClasses.length}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <span style={{ fontWeight: '600' }}>{p.name}</span>
                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                              {p.unwired && (
                                <span style={{ padding: '1px 6px', borderRadius: '4px', fontSize: '0.625rem', background: 'var(--color-warning-subtle)', color: 'var(--color-warning)' }}>
                                  unwired
                                </span>
                              )}
                              {!p.enabled && (
                                <span style={{ padding: '1px 6px', borderRadius: '4px', fontSize: '0.625rem', background: 'var(--color-surface-3)', color: 'var(--color-text-muted)' }}>
                                  disabled
                                </span>
                              )}
                            </div>
                          </div>
                        </Td>
                      )}
                      {idx === 0 && (
                        <Td rowSpan={p.requestClasses.length}>
                          <span
                            style={{
                              padding: '2px 8px',
                              borderRadius: '20px',
                              fontSize: '0.6875rem',
                              fontWeight: '500',
                              color: p.enabled && !p.unwired ? 'var(--color-success)' : p.unwired ? 'var(--color-warning)' : 'var(--color-text-muted)',
                              background: p.enabled && !p.unwired ? 'var(--color-success-subtle)' : p.unwired ? 'var(--color-warning-subtle)' : 'var(--color-surface-3)',
                            }}
                          >
                            {p.unwired ? 'unwired' : p.enabled ? 'active' : 'disabled'}
                          </span>
                        </Td>
                      )}
                      <Td>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.6875rem', color: 'var(--color-text-secondary)', background: 'var(--color-surface-2)', padding: '2px 6px', borderRadius: '4px' }}>
                          {rc.requestClass}
                        </span>
                      </Td>
                      <Td>{rc.requestsPerMinute}</Td>
                      <Td>{rc.burstCapacity}</Td>
                      <Td>{rc.maxWaitMs >= 1000 ? `${(rc.maxWaitMs / 1000).toFixed(1)}s` : `${rc.maxWaitMs}ms`}</Td>
                      <Td>{rc.cacheTtlMs === 0 ? '—' : rc.cacheTtlMs >= 60000 ? `${Math.round(rc.cacheTtlMs / 60000)}m` : `${Math.round(rc.cacheTtlMs / 1000)}s`}</Td>
                      <Td>{rc.counters.success ?? 0}</Td>
                      <Td>
                        <span style={{ color: (rc.counters.failure ?? 0) > 0 ? 'var(--color-danger)' : undefined }}>
                          {rc.counters.failure ?? 0}
                        </span>
                      </Td>
                      <Td>
                        <span style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>
                          {fmtTs(rc.counters.lastSuccessAt ?? null)}
                        </span>
                      </Td>
                      <Td>{rc.counters.freshnessModeFresh ?? 0}</Td>
                      <Td>{rc.counters.freshnessModeCached ?? 0}</Td>
                      <Td>{rc.counters.rateLimitWaitCount ?? 0}</Td>
                      <Td>
                        <span style={{ color: (rc.counters.rateLimitThrottleCount ?? 0) > 0 ? 'var(--color-warning)' : undefined }}>
                          {rc.counters.rateLimitThrottleCount ?? 0}
                        </span>
                      </Td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: '600', color: 'var(--color-text-secondary)', fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
      {children}
    </th>
  );
}

function Td({ children, rowSpan }: { children: React.ReactNode; rowSpan?: number }) {
  return (
    <td rowSpan={rowSpan} style={{ padding: '10px 16px', color: 'var(--color-text-primary)', verticalAlign: 'middle' }}>
      {children}
    </td>
  );
}

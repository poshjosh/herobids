
export const WAKE_SOURCES = [
  { value: 'reminder', label: 'Reminders', description: 'Agent-scheduled reminders' },
  { value: 'watch_threshold', label: 'Watch Thresholds', description: 'Price threshold alerts' },
  { value: 'discovery_delta', label: 'Discovery Deltas', description: 'Newly trending tokens' },
  { value: 'regime_change', label: 'Regime Changes', description: 'Market regime shifts' },
  { value: 'scanner', label: 'Scanner', description: 'Technical scan signals' },
] as const;

export type WakeSourceValue = (typeof WAKE_SOURCES)[number]['value'];

/** Wake sources that are only relevant for trading agents.
 *  Excludes 'reminder' — reminders are always-on for all agents (see
 *  AgentFormBody for the enforcement logic). */
export const TRADING_WAKE_SOURCES = WAKE_SOURCES.filter(s => s.value !== 'reminder');

interface WakeSourceSectionProps {
  selected: string[];
  onChange: (sources: string[]) => void;
  disabled?: boolean;
  /** Which wake sources to show. Defaults to all. */
  sources?: readonly { value: string; label: string; description: string }[];
}

export function WakeSourceSection({ selected, onChange, disabled, sources }: WakeSourceSectionProps) {
  const visibleSources = sources ?? WAKE_SOURCES;
  const totalSources = visibleSources.length;

  const toggle = (source: string) => {
    if (selected.includes(source)) {
      onChange(selected.filter(s => s !== source));
    } else {
      onChange([...selected, source]);
    }
  };

  const isAllSources = selected.length === 0;

  // When only a subset of sources is visible (e.g. trading-only), count and
  // report only the visible ones — hidden forced sources (like reminders) are
  // excluded from the UX count.
  const visibleSelected = selected.filter(s => visibleSources.some(vs => vs.value === s));
  const hasExplicitVisibleSelection = visibleSelected.length > 0;

  return (
    <div>
      {visibleSources.length > 0 && (
        <p style={{ fontWeight: 600, fontSize: '14px', marginBottom: '6px' }}>
          {isAllSources
            ? 'Receiving all wake sources. Select specific sources to filter.'
            : hasExplicitVisibleSelection
              ? `Receiving ${visibleSelected.length} of ${totalSources} wake sources.`
              : 'Receiving all wake sources. Select specific sources to filter.'}
        </p>
      )}
      {visibleSources.map(source => (
        <label
          key={source.value}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginBottom: '0.25rem',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.6 : 1,
          }}
        >
          <input
            type="checkbox"
            checked={selected.includes(source.value)}
            onChange={() => toggle(source.value)}
            disabled={disabled}
          />
          <span style={{ fontSize: '12px', fontWeight: '500', color: 'var(--color-text-secondary)' }}>
            {source.label}
            <span style={{ color: 'var(--color-text-secondary)', marginLeft: '0.5rem', fontSize: '0.8rem' }}>
              — {source.description}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

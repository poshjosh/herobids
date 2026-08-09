
export const WAKE_SOURCES = [
  { value: 'reminder', label: 'Reminders', description: 'Agent-scheduled reminders' },
  { value: 'watch_threshold', label: 'Watch Thresholds', description: 'Price alerts' },
  { value: 'discovery_delta', label: 'Discovery Deltas', description: 'Newly trending tokens' },
  { value: 'regime_change', label: 'Regime Changes', description: 'Market regime shifts' },
  { value: 'scanner', label: 'Scanner', description: 'Technical scan signals' },
] as const;

export type WakeSourceValue = (typeof WAKE_SOURCES)[number]['value'];

/** Wake sources that are only relevant for trading agents.
 *  Excludes 'reminder' (always-on for all agents) and 'scanner' (implicitly
 *  controlled by the technical pre-filter toggle — when pre-filter is on,
 *  scanner wakes are delivered; when off, they are not). */
export const TRADING_WAKE_SOURCES = WAKE_SOURCES.filter(s => s.value !== 'reminder' && s.value !== 'scanner');

interface WakeSourceSectionProps {
  selected: string[];
  onChange: (sources: string[]) => void;
  disabled?: boolean;
  /** Which wake sources to show. Defaults to all. */
  sources?: readonly { value: string; label: string; description: string }[];
}

export function WakeSourceSection({ selected, onChange, disabled, sources }: WakeSourceSectionProps) {
  const visibleSources = sources ?? WAKE_SOURCES;

  const toggle = (source: string) => {
    if (selected.includes(source)) {
      onChange(selected.filter(s => s !== source));
    } else {
      onChange([...selected, source]);
    }
  };

  return (
    <div>
      <div style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '8px', color: 'var(--color-text-primary)' }}>
        Which notices should the agent receive?
      </div>
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
          <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-primary)' }}>
            {source.description}
          </span>
        </label>
      ))}
    </div>
  );
}

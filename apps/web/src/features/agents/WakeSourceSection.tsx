
const WAKE_SOURCES = [
  { value: 'reminder', label: 'Reminders', description: 'Agent-scheduled reminders' },
  { value: 'watch_threshold', label: 'Watch Thresholds', description: 'Price threshold alerts' },
  { value: 'discovery_delta', label: 'Discovery Deltas', description: 'Newly trending tokens' },
  { value: 'regime_change', label: 'Regime Changes', description: 'Market regime shifts' },
  { value: 'scanner', label: 'Scanner', description: 'Technical scan signals' },
] as const;

interface WakeSourceSectionProps {
  selected: string[];
  onChange: (sources: string[]) => void;
  disabled?: boolean;
}

export function WakeSourceSection({ selected, onChange, disabled }: WakeSourceSectionProps) {
  const toggle = (source: string) => {
    if (selected.includes(source)) {
      onChange(selected.filter(s => s !== source));
    } else {
      onChange([...selected, source]);
    }
  };

  const isAllSources = selected.length === 0;

  return (
    <div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
        {isAllSources
          ? 'Receiving all wake sources. Select specific sources to filter.'
          : `Receiving ${selected.length} of ${WAKE_SOURCES.length} wake sources.`}
      </p>
      {WAKE_SOURCES.map(source => (
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
          <span>
            <strong>{source.label}</strong>
            <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem', fontSize: '0.8rem' }}>
              — {source.description}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

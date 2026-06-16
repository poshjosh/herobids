import { useIntl } from 'react-intl';

export type CapabilityMode = 'intelligence' | 'technical' | 'both';

interface CapabilitySelectorProps {
  value: CapabilityMode;
  onChange: (mode: CapabilityMode) => void;
}

const MODES: Array<{
  id: CapabilityMode;
  labelKey: string;
  descriptionKey: string;
  costKey: string;
  icon: string;
}> = [
  {
    id: 'intelligence',
    labelKey: 'agents.capability.intelligence.label',
    descriptionKey: 'agents.capability.intelligence.description',
    costKey: 'agents.capability.intelligence.cost',
    icon: '◎',
  },
  {
    id: 'technical',
    labelKey: 'agents.capability.technical.label',
    descriptionKey: 'agents.capability.technical.description',
    costKey: 'agents.capability.technical.cost',
    icon: '◈',
  },
  {
    id: 'both',
    labelKey: 'agents.capability.both.label',
    descriptionKey: 'agents.capability.both.description',
    costKey: 'agents.capability.both.cost',
    icon: '⊞',
  },
];

export function CapabilitySelector({ value, onChange }: CapabilitySelectorProps) {
  const intl = useIntl();

  return (
    <div role="group" aria-labelledby="capability-selector-label">
      <div id="capability-selector-label" style={{ fontSize: '13px', fontWeight: '500', color: 'var(--color-text-secondary)', marginBottom: '8px' }}>
        {intl.formatMessage({ id: 'agents.capability.title' })}
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        {MODES.map((mode) => {
          const active = value === mode.id;
          return (
            <button
              key={mode.id}
              type="button"
              onClick={() => onChange(mode.id)}
              aria-pressed={active}
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: '8px',
                border: `1.5px solid ${active ? 'var(--color-brand)' : 'var(--color-border)'}`,
                background: active ? 'var(--color-brand-subtle, rgba(99,102,241,0.06))' : 'var(--color-surface-1)',
                cursor: 'pointer',
                textAlign: 'left' as const,
                transition: 'border-color 0.12s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <span style={{ fontSize: '14px' }}>{mode.icon}</span>
                <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
                  {intl.formatMessage({ id: mode.labelKey })}
                </span>
                {active && (
                  <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--color-brand)' }}>✓</span>
                )}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', lineHeight: '1.4', marginBottom: '4px' }}>
                {intl.formatMessage({ id: mode.descriptionKey })}
              </div>
              <div
                style={{
                  fontSize: '10px',
                  fontWeight: '600',
                  color: mode.id === 'technical' ? 'var(--color-success, #22c55e)' : 'var(--color-text-muted)',
                  textTransform: 'uppercase' as const,
                  letterSpacing: '0.04em',
                }}
              >
                {intl.formatMessage({ id: mode.costKey })}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

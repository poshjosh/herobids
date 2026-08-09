import { useIntl } from 'react-intl';

export type CapabilityMode = 'intelligence' | 'hybrid';

export type HybridMode = 'mixed' | 'scanner_gated';

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
    id: 'hybrid',
    labelKey: 'agents.capability.hybrid.label',
    descriptionKey: 'agents.capability.hybrid.description',
    costKey: 'agents.capability.hybrid.cost',
    icon: '⊞',
  },
];

export function CapabilitySelector({ value, onChange }: CapabilitySelectorProps) {
  const intl = useIntl();

  return (
    <div role="group" aria-labelledby="capability-selector-label">
      <div id="capability-selector-label" style={{ fontSize: '0.8125rem', fontWeight: '500', color: 'var(--color-text-secondary)', marginBottom: '8px' }}>
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
                <span style={{ fontSize: '0.875rem' }}>{mode.icon}</span>
                <span style={{ fontSize: '0.8125rem', fontWeight: '600', color: 'var(--color-text-primary)' }}>
                  {intl.formatMessage({ id: mode.labelKey })}
                </span>
                {active && (
                  <span style={{ marginLeft: 'auto', fontSize: '0.6875rem', color: 'var(--color-brand)' }}>✓</span>
                )}
              </div>
              <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)', lineHeight: '1.4', marginBottom: '4px' }}>
                {intl.formatMessage({ id: mode.descriptionKey })}
              </div>
              <div
                style={{
                  fontSize: '0.625rem',
                  fontWeight: '600',
                  color: 'var(--color-text-muted)',
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

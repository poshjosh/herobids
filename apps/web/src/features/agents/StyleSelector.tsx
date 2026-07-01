import { useIntl } from 'react-intl';
import type { AgentStyleValue } from './style-mapping.js';

interface StyleSelectorProps {
  value: AgentStyleValue;
  onChange: (style: AgentStyleValue) => void;
}

const STYLES: Array<{
  id: AgentStyleValue;
  labelKey: string;
  descriptionKey: string;
  icon: string;
}> = [
  {
    id: 'careful',
    labelKey: 'agents.style.careful.label',
    descriptionKey: 'agents.style.careful.description',
    icon: '🪙',
  },
  {
    id: 'balanced',
    labelKey: 'agents.style.balanced.label',
    descriptionKey: 'agents.style.balanced.description',
    icon: '⚖️',
  },
  {
    id: 'bold',
    labelKey: 'agents.style.bold.label',
    descriptionKey: 'agents.style.bold.description',
    icon: '💎',
  },
];

export function StyleSelector({ value, onChange }: StyleSelectorProps) {
  const intl = useIntl();

  return (
    <div role="radiogroup" aria-labelledby="style-selector-label">
      <div id="style-selector-label" style={{ fontSize: '13px', fontWeight: '500', color: 'var(--color-text-secondary)', marginBottom: '4px' }}>
        {intl.formatMessage({ id: 'agents.style.title' })}
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        {STYLES.map((style) => {
          const active = value === style.id;
          return (
            <label
              key={style.id}
              title={intl.formatMessage({ id: style.descriptionKey })}
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: '8px',
                border: `1.5px solid ${active ? 'var(--color-brand)' : 'var(--color-border)'}`,
                background: active ? 'var(--color-brand-subtle, rgba(99,102,241,0.06))' : 'var(--color-surface-1)',
                cursor: 'pointer',
                textAlign: 'left' as const,
                transition: 'border-color 0.12s',
                position: 'relative',
              }}
            >
              <input
                type="radio"
                name="agent-style"
                value={style.id}
                checked={active}
                onChange={() => onChange(style.id)}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '14px' }}>{style.icon}</span>
                <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
                  {intl.formatMessage({ id: style.labelKey })}
                </span>
                {active && (
                  <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--color-brand)' }}>✓</span>
                )}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

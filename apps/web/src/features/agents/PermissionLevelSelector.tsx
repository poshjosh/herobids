import { useIntl } from 'react-intl';

type PermissionLevel = 'restricted' | 'standard' | 'full';

interface PermissionLevelSelectorProps {
  value: PermissionLevel;
  onChange: (level: PermissionLevel) => void;
}

const LEVELS: Array<{
  id: PermissionLevel;
  labelKey: string;
  descriptionKey: string;
  isDefault: boolean;
}> = [
  {
    id: 'restricted',
    labelKey: 'agents.permissionLevel.restricted.label',
    descriptionKey: 'agents.permissionLevel.restricted.description',
    isDefault: false,
  },
  {
    id: 'standard',
    labelKey: 'agents.permissionLevel.standard.label',
    descriptionKey: 'agents.permissionLevel.standard.description',
    isDefault: true,
  },
  {
    id: 'full',
    labelKey: 'agents.permissionLevel.full.label',
    descriptionKey: 'agents.permissionLevel.full.description',
    isDefault: false,
  },
];

export function PermissionLevelSelector({ value, onChange }: PermissionLevelSelectorProps) {
  const intl = useIntl();

  return (
    <div>
      <div
        id="permission-level-label"
        style={{ fontWeight: 600, fontSize: '0.875rem', marginBottom: '6px' }}
      >
        {intl.formatMessage({ id: 'agents.permissionLevel.label' })}
      </div>
      <div
        role="radiogroup"
        aria-labelledby="permission-level-label"
        style={{ display: 'flex', gap: '8px' }}
      >
        {LEVELS.map((level) => {
          const active = value === level.id;
          return (
            <label
              key={level.id}
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: '8px',
                border: `1.5px solid ${active ? 'var(--color-brand)' : 'var(--color-border)'}`,
                background: active
                  ? 'var(--color-brand-subtle, rgba(99,102,241,0.06))'
                  : 'var(--color-surface-1)',
                cursor: 'pointer',
                textAlign: 'left' as const,
                transition: 'border-color 0.12s',
              }}
            >
              <input
                type="radio"
                name="permission-level"
                value={level.id}
                checked={active}
                onChange={() => onChange(level.id)}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  {intl.formatMessage({ id: level.labelKey })}
                </span>
                {level.isDefault && (
                  <span style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>
                    {intl.formatMessage({ id: 'agents.permissionLevel.default' })}
                  </span>
                )}
                {active && (
                  <span style={{ marginLeft: 'auto', fontSize: '0.6875rem', color: 'var(--color-brand)' }}>
                    &#x2713;
                  </span>
                )}
              </div>
              <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)', lineHeight: '1.4' }}>
                {intl.formatMessage({ id: level.descriptionKey })}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

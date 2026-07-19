import { useIntl } from 'react-intl';
import { FieldLabel } from './ui.js';
import type { PresetFromApi } from './api-client.js';

// ---------------------------------------------------------------------------
// StrategyPresetSelector
// ---------------------------------------------------------------------------
//
// A card-based selector for style-based strategy presets, driven entirely by
// backend data (`/blueprints/presets`). No duplicated frontend constants.
//
// The parent is responsible for filtering which presets to surface (e.g.
// agents exclude DCA; bots show everything). Pass `showCustom={false}` when
// a free-form custom mode is not applicable (e.g. bot creation).
// ---------------------------------------------------------------------------

interface StrategyPresetSelectorProps {
  value: string;
  onChange: (key: string) => void;
  /** Presets to display — caller filters before passing. */
  presets: PresetFromApi[];
  /** True while presets are being fetched from the backend. */
  loading?: boolean;
  /** Show a "Custom" card for free-form technical config (default: true). */
  showCustom?: boolean;
}

export function StrategyPresetSelector({
  value,
  onChange,
  presets,
  loading,
  showCustom = true,
}: StrategyPresetSelectorProps) {
  const intl = useIntl();
  const cardStyle = (active: boolean): React.CSSProperties => ({
    padding: '10px 12px',
    borderRadius: '8px',
    border: `1px solid ${active ? 'var(--color-brand)' : 'var(--color-border)'}`,
    background: active
      ? 'var(--color-brand-subtle, rgba(99,102,241,0.06))'
      : 'var(--color-surface-1)',
    cursor: 'pointer',
    textAlign: 'left' as const,
    transition: 'border-color 0.15s, background 0.15s',
  });

  return (
    <div>
      <FieldLabel>{intl.formatMessage({ id: 'agents.technical.preset.label' })}</FieldLabel>
      {loading ? (
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', padding: '8px 0' }}>
          Loading presets…
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
          {presets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              style={cardStyle(value === preset.key)}
              onClick={() => onChange(preset.key)}
              aria-pressed={value === preset.key}
            >
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: '600',
                  color: 'var(--color-text-primary)',
                  marginBottom: '4px',
                }}
              >
                {preset.name}
              </div>
              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--color-text-secondary)',
                  lineHeight: '1.4',
                }}
              >
                {preset.description}
              </div>
            </button>
          ))}
          {showCustom && (
            <button
              type="button"
              style={cardStyle(value === 'custom' || !value)}
              onClick={() => onChange('custom')}
              aria-pressed={value === 'custom' || !value}
            >
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: '600',
                  color: 'var(--color-text-primary)',
                  marginBottom: '4px',
                }}
              >
                Custom
              </div>
              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--color-text-secondary)',
                  lineHeight: '1.4',
                }}
              >
                Manually configure all technical parameters. No preset defaults.
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

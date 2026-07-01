import { useIntl } from 'react-intl';
import { FieldLabel } from '../../lib/ui.js';

export const STRATEGY_PRESETS = [
  { key: 'momentum', label: 'Momentum — Day', description: 'Intraday trend-following using RSI, MACD, and price action signals.' },
  { key: 'momentum-position', label: 'Momentum — Position', description: 'Longer-term trend-following for multi-day swings with wider stops.' },
  { key: 'range', label: 'Range Trading', description: 'Support/resistance bounces and breakouts in sideways markets.' },
  { key: 'swing', label: 'Swing', description: 'Short-to-medium term price swings. Identifies swing highs/lows.' },
  { key: 'scalper', label: 'Scalper', description: 'High-frequency micro-scalps with tight stops and fast execution.' },
  { key: 'contrarian', label: 'Contrarian', description: 'Trades against extremes. Buys fear, sells greed.' },
] as const;

export type StrategyPresetKey = (typeof STRATEGY_PRESETS)[number]['key'];

export const STRATEGY_PRESET_KEYS = STRATEGY_PRESETS.map((p) => p.key);

interface StrategyPresetSelectorProps {
  value: string;
  onChange: (key: string) => void;
  style: string | null | undefined;
}

/**
 * A card-based selector for the 6 style-based strategy presets.
 * "Custom" mode preserves the detailed technical editor.
 */
export function StrategyPresetSelector({ value, onChange, style }: StrategyPresetSelectorProps) {
  const intl = useIntl();

  const cardStyle = (active: boolean): React.CSSProperties => ({
    flex: '1 1 140px',
    maxWidth: '200px',
    padding: '10px 12px',
    borderRadius: '8px',
    border: `1px solid ${active ? 'var(--color-brand)' : 'var(--color-border)'}`,
    background: active ? 'var(--color-brand-subtle, rgba(99,102,241,0.06))' : 'var(--color-surface-1)',
    cursor: 'pointer',
    textAlign: 'left' as const,
    transition: 'border-color 0.15s, background 0.15s',
  });

  const styleLabel = style === 'careful' ? 'Economy' : style === 'bold' ? 'Premium' : 'Standard';

  return (
    <div>
      <FieldLabel>Strategy preset</FieldLabel>
      <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '4px 0 8px' }}>
        Style tier <strong>{styleLabel}</strong> is derived from your agent style.
        Technical parameters are scaled automatically.
      </p>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {STRATEGY_PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            style={cardStyle(value === preset.key)}
            onClick={() => onChange(preset.key)}
          >
            <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--color-text-primary)', marginBottom: '4px' }}>
              {preset.label}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', lineHeight: '1.4' }}>
              {preset.description}
            </div>
          </button>
        ))}
        <button
          type="button"
          style={cardStyle(value === 'custom' || !value)}
          onClick={() => onChange('custom')}
        >
          <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--color-text-primary)', marginBottom: '4px' }}>
            Custom
          </div>
          <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', lineHeight: '1.4' }}>
            Manually configure all technical parameters. No preset defaults.
          </div>
        </button>
      </div>
    </div>
  );
}

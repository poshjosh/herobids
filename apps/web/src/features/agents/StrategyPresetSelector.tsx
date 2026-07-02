import { FieldLabel } from '../../lib/ui.js';
import type { PresetFromApi } from '../../lib/api-client.js';

/**
 * Strategy preset keys that are valid for agents.
 * DCA is intentionally excluded — it is a bot-only strategy and the API
 * rejects it for agent preset application (preset_not_supported_for_agent).
 */
export const AGENT_STRATEGY_PRESET_KEYS = [
  'momentum',
  'momentum-position',
  'range',
  'swing',
  'scalper',
  'contrarian',
] as const;

export type AgentStrategyPresetKey = (typeof AGENT_STRATEGY_PRESET_KEYS)[number];

interface StrategyPresetSelectorProps {
  value: string;
  onChange: (key: string) => void;
  /** Backend-provided presets for the resolved style tier. The single source of truth for
   *  preset identity, labels, and descriptions — no duplicated frontend constants. */
  presets: PresetFromApi[];
  /** True while presets are being fetched from the backend. */
  loading?: boolean;
}

/**
 * A card-based selector for the style-based strategy presets.
 * Preset cards are driven entirely by backend data (`/blueprints/presets`),
 * not by duplicated frontend constants. "Custom" mode exposes the detailed
 * technical editor for manual overrides.
 */
export function StrategyPresetSelector({ value, onChange, presets, loading }: StrategyPresetSelectorProps) {
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

  // Only surface presets that are meaningful for agents (exclude DCA and any
  // future bot-only strategies). Backend remains the source of truth for the
  // preset content; this filter is purely about agent applicability.
  const agentPresets = presets.filter((p) =>
    (AGENT_STRATEGY_PRESET_KEYS as readonly string[]).includes(p.key),
  );

  return (
    <div>
      <FieldLabel>Strategy preset</FieldLabel>
      {loading ? (
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', padding: '8px 0' }}>
          Loading presets…
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
          {agentPresets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              style={cardStyle(value === preset.key)}
              onClick={() => onChange(preset.key)}
              aria-pressed={value === preset.key}
            >
              <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--color-text-primary)', marginBottom: '4px' }}>
                {preset.name}
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
            aria-pressed={value === 'custom' || !value}
          >
            <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--color-text-primary)', marginBottom: '4px' }}>
              Custom
            </div>
            <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', lineHeight: '1.4' }}>
              Manually configure all technical parameters. No preset defaults.
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

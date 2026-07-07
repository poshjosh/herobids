import { FieldLabel, inputStyle } from '../../lib/ui.js';

export interface BotCustomConfigFormState {
  // Strategy identity
  strategyType: 'momentum' | 'range' | 'contrarian' | 'swing' | 'scalper';
  decisionMode: 'mechanical'; // only mechanical in v1; llm/hybrid deferred

  // Signal interpretation (mechanical params)
  signalBias: 'trend-following' | 'mean-reverting';
  candleInterval: '5m' | '15m' | '1H' | '4H' | '1D';
  candleLimit: string; // controlled number input → parseInt

  // Exit targets (mechanical params — both required for mechanical strategy)
  stopLossPct: string;
  takeProfitPct: string;
  trailingStopPct: string; // empty string = null (no trailing stop)

  // Position sizing (mechanical params)
  positionSize: string;
  positionSizeMode: 'fixed' | 'percent_equity';

  // Risk guardrails (all optional — only sent when non-empty)
  maxPositionSizePct: string;
  maxOpenPositions: string;
  dailyMaxLossPct: string;
  stopLossMaxUnrealizedLossPct: string;
}

export const defaultBotCustomConfig: BotCustomConfigFormState = {
  strategyType: 'momentum',
  decisionMode: 'mechanical',
  signalBias: 'trend-following',
  candleInterval: '15m',
  candleLimit: '48',
  stopLossPct: '',
  takeProfitPct: '',
  trailingStopPct: '',
  positionSize: '100',
  positionSizeMode: 'percent_equity',
  maxPositionSizePct: '',
  maxOpenPositions: '',
  dailyMaxLossPct: '',
  stopLossMaxUnrealizedLossPct: '',
};

export interface BotCustomConfigSectionProps {
  value: BotCustomConfigFormState;
  onChange: (patch: Partial<BotCustomConfigFormState>) => void;
  isSwapVenue: boolean;
}

export function BotCustomConfigSection({ value, onChange, isSwapVenue }: BotCustomConfigSectionProps) {
  const sectionTitleStyle: React.CSSProperties = {
    fontSize: '13px',
    fontWeight: '600',
    color: 'var(--color-text-primary)',
  };

  const cardStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '12px',
    border: '1px solid var(--color-border)',
    borderRadius: '8px',
  };

  const toggleBtnStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '8px',
    borderRadius: '6px',
    border: `1px solid ${active ? 'var(--color-brand)' : 'var(--color-border)'}`,
    background: active ? 'var(--color-brand-subtle, rgba(99,102,241,0.06))' : 'transparent',
    cursor: 'pointer',
    fontSize: '13px',
    color: 'var(--color-text-primary)',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Strategy */}
      <div style={cardStyle}>
        <div style={sectionTitleStyle}>Strategy</div>

        <div>
          <FieldLabel>Strategy type</FieldLabel>
          <select
            style={{ ...inputStyle, cursor: 'pointer' }}
            value={value.strategyType}
            onChange={(e) => onChange({ strategyType: e.target.value as BotCustomConfigFormState['strategyType'] })}
          >
            <option value="momentum">Momentum</option>
            <option value="range">Range</option>
            <option value="contrarian">Contrarian</option>
            <option value="swing">Swing</option>
            <option value="scalper">Scalper</option>
          </select>
        </div>

        {isSwapVenue && (
          <div style={{
            fontSize: '12px',
            color: 'var(--color-text-muted)',
            fontStyle: 'italic',
            padding: '8px',
            background: 'var(--color-surface-2)',
            borderRadius: '6px',
          }}>
            Swap venue detected — candle-based parameters are not applicable. Configure position sizing and risk limits only.
          </div>
        )}

        {!isSwapVenue && (
          <>
            <div>
              <FieldLabel>Signal bias</FieldLabel>
              <div style={{ display: 'flex', gap: '8px' }}>
                {(['trend-following', 'mean-reverting'] as const).map((bias) => (
                  <button
                    key={bias}
                    type="button"
                    onClick={() => onChange({ signalBias: bias })}
                    style={toggleBtnStyle(value.signalBias === bias)}
                    aria-pressed={value.signalBias === bias}
                  >
                    {bias === 'trend-following' ? 'Trend-following' : 'Mean-reverting'}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <FieldLabel>Candle interval</FieldLabel>
              <select
                style={{ ...inputStyle, cursor: 'pointer' }}
                value={value.candleInterval}
                onChange={(e) => onChange({ candleInterval: e.target.value as BotCustomConfigFormState['candleInterval'] })}
              >
                <option value="5m">5m</option>
                <option value="15m">15m</option>
                <option value="1H">1H</option>
                <option value="4H">4H</option>
                <option value="1D">1D</option>
              </select>
            </div>

            <div>
              <FieldLabel>Candle limit</FieldLabel>
              <input
                style={inputStyle}
                type="number"
                min={20}
                max={500}
                value={value.candleLimit}
                onChange={(e) => onChange({ candleLimit: e.target.value })}
              />
            </div>
          </>
        )}
      </div>

      {/* Exit Targets */}
      <div style={cardStyle}>
        <div style={sectionTitleStyle}>Exit Targets</div>

        <div>
          <FieldLabel>Stop loss %</FieldLabel>
          <input
            style={inputStyle}
            type="number"
            min={0}
            max={100}
            required
            value={value.stopLossPct}
            onChange={(e) => onChange({ stopLossPct: e.target.value })}
          />
        </div>

        <div>
          <FieldLabel>Take profit %</FieldLabel>
          <input
            style={inputStyle}
            type="number"
            min={0}
            required
            value={value.takeProfitPct}
            onChange={(e) => onChange({ takeProfitPct: e.target.value })}
          />
        </div>

        <div>
          <FieldLabel>Trailing stop %</FieldLabel>
          <input
            style={inputStyle}
            type="number"
            placeholder="optional"
            value={value.trailingStopPct}
            onChange={(e) => onChange({ trailingStopPct: e.target.value })}
          />
        </div>
      </div>

      {/* Position Sizing */}
      <div style={cardStyle}>
        <div style={sectionTitleStyle}>Position Sizing</div>

        <div>
          <FieldLabel>Position size</FieldLabel>
          <input
            style={inputStyle}
            value={value.positionSize}
            onChange={(e) => onChange({ positionSize: e.target.value })}
          />
        </div>

        <div>
          <FieldLabel>Size mode</FieldLabel>
          <div style={{ display: 'flex', gap: '8px' }}>
            {(['fixed', 'percent_equity'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChange({ positionSizeMode: mode })}
                style={toggleBtnStyle(value.positionSizeMode === mode)}
                aria-pressed={value.positionSizeMode === mode}
              >
                {mode === 'fixed' ? 'Fixed' : '% of equity'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Risk Guardrails */}
      <div style={cardStyle}>
        <div style={sectionTitleStyle}>Risk Guardrails</div>

        <div>
          <FieldLabel>Max position size %</FieldLabel>
          <input
            style={inputStyle}
            type="number"
            placeholder="use default"
            value={value.maxPositionSizePct}
            onChange={(e) => onChange({ maxPositionSizePct: e.target.value })}
          />
        </div>

        <div>
          <FieldLabel>Max open positions</FieldLabel>
          <input
            style={inputStyle}
            type="number"
            placeholder="use default"
            value={value.maxOpenPositions}
            onChange={(e) => onChange({ maxOpenPositions: e.target.value })}
          />
        </div>

        <div>
          <FieldLabel>Daily loss limit %</FieldLabel>
          <input
            style={inputStyle}
            type="number"
            placeholder="use default"
            value={value.dailyMaxLossPct}
            onChange={(e) => onChange({ dailyMaxLossPct: e.target.value })}
          />
        </div>

        <div>
          <FieldLabel>Max unrealized loss %</FieldLabel>
          <input
            style={inputStyle}
            type="number"
            placeholder="use default"
            value={value.stopLossMaxUnrealizedLossPct}
            onChange={(e) => onChange({ stopLossMaxUnrealizedLossPct: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

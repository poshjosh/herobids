import { useIntl } from 'react-intl';
import { FieldLabel, inputStyle } from '../../lib/ui.js';
import { deriveExpectedCadence, estimateDailySpend, hasExplicitTickInterval } from './agent-cadence.js';
import { parseTickIntervalMinutesInput } from './tick-interval.js';

export type AgentCostPresetValue = '' | 'minimal' | 'standard' | 'premium' | 'custom';

export interface AgentControlsFormValue {
  costPreset: AgentCostPresetValue;
  dailySpendBudgetUsd: string;
  tickIntervalMins: string;
  maxBots: string;
  capital: string;
  dailyLossLimit: string;
  maxSlippageBps: string;
  maxOpenPositions: string;
  maxPositionSizePct: string;
  stopLossPct: string;
  stopLossCooldownSecs: string;
}

interface AgentControlsSectionProps {
  value: AgentControlsFormValue;
  onChange: (patch: Partial<AgentControlsFormValue>) => void;
  showBotControls: boolean;
  tickIntervalError?: string | null;
  tickIntervalNotice?: string | null;
  effectiveTickIntervalMs?: number | null;
}

export interface TradingGuardrailsFormValue {
  capital: string;
  dailyLossLimit: string;
  maxSlippageBps: string;
  maxOpenPositions: string;
  maxPositionSizePct: string;
  stopLossPct: string;
  stopLossCooldownSecs: string;
}

export interface AgentRiskDefaultsView {
  maxOpenPositions: number;
  maxPositionSizePct: number;
  stopLossPct: number;
  stopLossCooldownMs: number;
}

interface TradingGuardrailsFieldsProps {
  value: TradingGuardrailsFormValue;
  onChange: (patch: Partial<TradingGuardrailsFormValue>) => void;
  defaults?: AgentRiskDefaultsView | null;
}

export function AgentControlsSection({
  value,
  onChange,
  showBotControls,
  tickIntervalError = null,
  tickIntervalNotice = null,
  effectiveTickIntervalMs = null,
}: AgentControlsSectionProps) {
  const intl = useIntl();
  const parsedTickInterval = parseTickIntervalMinutesInput(value.tickIntervalMins);
  const tickIntervalMsValue = effectiveTickIntervalMs != null
    ? String(effectiveTickIntervalMs)
    : parsedTickInterval.kind === 'valid'
      ? String(parsedTickInterval.tickIntervalMs)
      : '';
  const explicitCadence = hasExplicitTickInterval(tickIntervalMsValue || null);
  const cadence = deriveExpectedCadence(
    tickIntervalMsValue || null,
    value.costPreset || null,
    value.dailySpendBudgetUsd || null,
  );
  const estimatedDailySpend = estimateDailySpend(
    tickIntervalMsValue || null,
    value.costPreset || null,
    value.dailySpendBudgetUsd ? Number(value.dailySpendBudgetUsd) : null,
  );

  const sectionStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '16px',
    border: '1px solid var(--color-border)',
    borderRadius: '8px',
    background: 'var(--color-surface-1)',
  };
  const rowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' };
  const helperTextStyle: React.CSSProperties = { marginTop: '4px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' };
  const errorTextStyle: React.CSSProperties = { ...helperTextStyle, color: 'var(--color-danger)' };

  return (
    <div style={sectionStyle}>
      <div>
        <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '4px' }}>
          {intl.formatMessage({ id: 'agents.create.controls.title' })}
        </div>
        <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
          {intl.formatMessage({ id: 'agents.create.controls.description' })}
        </div>
      </div>

      <div style={rowStyle}>
        <div>
          <FieldLabel>{intl.formatMessage({ id: 'agents.controls.costPreset' })}</FieldLabel>
          <select
            style={{ ...inputStyle, cursor: 'pointer' }}
            value={value.costPreset}
            onChange={(event) => onChange({ costPreset: event.target.value as AgentCostPresetValue })}
          >
            <option value="">{intl.formatMessage({ id: 'agents.controls.costPreset.systemDefault' })}</option>
            <option value="minimal">{intl.formatMessage({ id: 'agents.controls.costPreset.minimal' })}</option>
            <option value="standard">{intl.formatMessage({ id: 'agents.controls.costPreset.standard' })}</option>
            <option value="premium">{intl.formatMessage({ id: 'agents.controls.costPreset.premium' })}</option>
            <option value="custom">{intl.formatMessage({ id: 'agents.controls.costPreset.custom' })}</option>
          </select>
          <div style={helperTextStyle}>
            {intl.formatMessage({ id: 'agents.controls.costPreset.help' })}
          </div>
        </div>
        <div>
          <FieldLabel>{intl.formatMessage({ id: 'agents.controls.dailySpendBudget' })}</FieldLabel>
          <input
            style={inputStyle}
            type="number"
            min={0.01}
            step="0.01"
            value={value.dailySpendBudgetUsd}
            onChange={(event) => onChange({ dailySpendBudgetUsd: event.target.value })}
            placeholder={intl.formatMessage({ id: 'common.optional' })}
          />
          <div style={helperTextStyle}>
            {intl.formatMessage({ id: 'agents.controls.dailySpendBudget.help' })}
          </div>
        </div>
      </div>

      <div>
        <FieldLabel>{intl.formatMessage({ id: 'agents.controls.tickInterval' })}</FieldLabel>
        <input
          style={inputStyle}
          type="number"
          min={1}
          step={1}
          aria-invalid={tickIntervalError != null}
          value={value.tickIntervalMins}
          onChange={(event) => onChange({ tickIntervalMins: event.target.value })}
          placeholder={intl.formatMessage({ id: 'agents.controls.tickInterval.placeholder' })}
        />
        {tickIntervalError && <div style={errorTextStyle}>{tickIntervalError}</div>}
        {!tickIntervalError && tickIntervalNotice && <div style={helperTextStyle}>{tickIntervalNotice}</div>}
        {!tickIntervalError && cadence && (
          <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
            {explicitCadence
              ? intl.formatMessage({ id: 'agents.controls.tickInterval.slowdownCaveat' }, { cadence })
              : intl.formatMessage({ id: 'agents.controls.tickInterval.expectedCadence' }, { cadence })}
          </div>
        )}
      </div>

      {showBotControls && (
        <div>
          <FieldLabel>{intl.formatMessage({ id: 'agents.controls.maxBots' })}</FieldLabel>
          <input
            style={inputStyle}
            type="number"
            min={1}
            value={value.maxBots}
            onChange={(event) => onChange({ maxBots: event.target.value })}
            placeholder={intl.formatMessage({ id: 'common.unlimited' })}
          />
        </div>
      )}
      {estimatedDailySpend != null && (
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
          {intl.formatMessage({ id: 'agents.controls.estimatedDailySpend' }, { amount: estimatedDailySpend.toFixed(2) })}
        </div>
      )}
    </div>
  );
}

export function TradingGuardrailsFields({ value, onChange, defaults = null }: TradingGuardrailsFieldsProps) {
  const intl = useIntl();
  const helperTextStyle: React.CSSProperties = { marginTop: '4px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
      <div>
        <FieldLabel>{intl.formatMessage({ id: 'agents.controls.capital' })}</FieldLabel>
        <input
          style={inputStyle}
          value={value.capital}
          onChange={(event) => onChange({ capital: event.target.value })}
          placeholder={intl.formatMessage({ id: 'common.unlimited' })}
        />
        <div style={helperTextStyle}>
          {intl.formatMessage({ id: 'agents.controls.capital.help' })}
        </div>
      </div>

      <div>
        <FieldLabel>{intl.formatMessage({ id: 'agents.controls.dailyLossLimit' })}</FieldLabel>
        <input
          style={inputStyle}
          value={value.dailyLossLimit}
          onChange={(event) => onChange({ dailyLossLimit: event.target.value })}
          placeholder={intl.formatMessage({ id: 'common.unlimited' })}
        />
        <div style={helperTextStyle}>{intl.formatMessage({ id: 'agents.controls.dailyLossLimit.help' })}</div>
      </div>

      <div>
        <FieldLabel>{intl.formatMessage({ id: 'agents.controls.maxSlippage' })}</FieldLabel>
        <input
          style={inputStyle}
          type="number"
          min={0}
          value={value.maxSlippageBps}
          onChange={(event) => onChange({ maxSlippageBps: event.target.value })}
          placeholder={intl.formatMessage({ id: 'common.default' })}
        />
      </div>

      <div>
        <FieldLabel>{intl.formatMessage({ id: 'agents.controls.maxOpenPositions' })}</FieldLabel>
        <input
          style={inputStyle}
          type="number"
          min={1}
          value={value.maxOpenPositions}
          onChange={(event) => onChange({ maxOpenPositions: event.target.value })}
          placeholder={defaults ? String(defaults.maxOpenPositions) : intl.formatMessage({ id: 'common.default' })}
        />
        <div style={helperTextStyle}>{intl.formatMessage({ id: 'agents.controls.maxOpenPositions.help' })}</div>
      </div>

      <div>
        <FieldLabel>{intl.formatMessage({ id: 'agents.controls.maxPositionSizePct' })}</FieldLabel>
        <input
          style={inputStyle}
          type="number"
          min={0}
          max={100}
          step="0.01"
          value={value.maxPositionSizePct}
          onChange={(event) => onChange({ maxPositionSizePct: event.target.value })}
          placeholder={defaults ? String(defaults.maxPositionSizePct) : intl.formatMessage({ id: 'common.default' })}
        />
        <div style={helperTextStyle}>{intl.formatMessage({ id: 'agents.controls.maxPositionSizePct.help' })}</div>
      </div>

      <div>
        <FieldLabel>{intl.formatMessage({ id: 'agents.controls.stopLossPct' })}</FieldLabel>
        <input
          style={inputStyle}
          type="number"
          min={0}
          max={100}
          step="0.01"
          value={value.stopLossPct}
          onChange={(event) => onChange({ stopLossPct: event.target.value })}
          placeholder={defaults ? String(defaults.stopLossPct) : intl.formatMessage({ id: 'common.default' })}
        />
        <div style={helperTextStyle}>{intl.formatMessage({ id: 'agents.controls.stopLossPct.help' })}</div>
      </div>

      <div>
        <FieldLabel>{intl.formatMessage({ id: 'agents.controls.stopLossCooldown' })}</FieldLabel>
        <input
          style={inputStyle}
          type="number"
          min={0}
          step={1}
          value={value.stopLossCooldownSecs}
          onChange={(event) => onChange({ stopLossCooldownSecs: event.target.value })}
          placeholder={defaults ? String(Math.round(defaults.stopLossCooldownMs / 1000)) : intl.formatMessage({ id: 'common.default' })}
        />
        <div style={helperTextStyle}>{intl.formatMessage({ id: 'agents.controls.stopLossCooldown.help' })}</div>
      </div>
    </div>
  );
}
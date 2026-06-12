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
}

interface AgentControlsSectionProps {
  value: AgentControlsFormValue;
  onChange: (patch: Partial<AgentControlsFormValue>) => void;
  tickIntervalError?: string | null;
  tickIntervalNotice?: string | null;
  effectiveTickIntervalMs?: number | null;
}

export interface TradingGuardrailsFormValue {
  capital: string;
  dailyLossLimit: string;
  maxSlippageBps: string;
}

interface TradingGuardrailsFieldsProps {
  value: TradingGuardrailsFormValue;
  onChange: (patch: Partial<TradingGuardrailsFormValue>) => void;
}

export function AgentControlsSection({
  value,
  onChange,
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
      {estimatedDailySpend != null && (
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
          {intl.formatMessage({ id: 'agents.controls.estimatedDailySpend' }, { amount: estimatedDailySpend.toFixed(2) })}
        </div>
      )}
    </div>
  );
}

export function TradingGuardrailsFields({ value, onChange }: TradingGuardrailsFieldsProps) {
  const intl = useIntl();

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
        <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
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
    </div>
  );
}
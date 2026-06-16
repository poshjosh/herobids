import { useState } from 'react';
import { useIntl } from 'react-intl';
import { FieldLabel, inputStyle } from '../../lib/ui.js';
import { TECHNICAL_PRESETS } from './technical-presets.js';
import type { TechnicalPresetId } from './technical-presets.js';
import type { TechnicalConfigFormState, IndicatorFormState } from './technical-config-helpers.js';
import { applyPreset } from './technical-config-helpers.js';

interface TechnicalConfigSectionProps {
  value: TechnicalConfigFormState;
  onChange: (state: TechnicalConfigFormState) => void;
  showErrors?: boolean;
}

export function TechnicalConfigSection({ value, onChange, showErrors }: TechnicalConfigSectionProps) {
  const intl = useIntl();
  const [showScanSettings, setShowScanSettings] = useState(false);
  const [showIndicators, setShowIndicators] = useState(true);
  const [showConfidence, setShowConfidence] = useState(false);

  const set = (patch: Partial<TechnicalConfigFormState>) => onChange({ ...value, ...patch });
  const setFilters = (patch: Partial<TechnicalConfigFormState['filters']>) =>
    set({ filters: { ...value.filters, ...patch } });
  const setIndicators = (patch: Partial<IndicatorFormState>) =>
    set({ indicators: { ...value.indicators, ...patch } });
  const setConfidence = (patch: Partial<TechnicalConfigFormState['confidence']>) =>
    set({ confidence: { ...value.confidence, ...patch } });

  const handlePreset = (id: TechnicalPresetId) => onChange(applyPreset(id, value));

  const cardStyle = (active: boolean): React.CSSProperties => ({
    flex: '1',
    padding: '10px 12px',
    borderRadius: '8px',
    border: `1px solid ${active ? 'var(--color-brand)' : 'var(--color-border)'}`,
    background: active ? 'var(--color-brand-subtle, rgba(99,102,241,0.06))' : 'var(--color-surface-1)',
    cursor: 'pointer',
    textAlign: 'left' as const,
  });

  const sectionHeader = (label: string, open: boolean, toggle: () => void): React.ReactElement => (
    <button
      type="button"
      onClick={toggle}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        background: 'none',
        border: 'none',
        padding: '8px 0',
        cursor: 'pointer',
        fontSize: '13px',
        fontWeight: '600',
        color: 'var(--color-text-primary)',
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{open ? '▲' : '▼'}</span>
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Preset selector */}
      <div>
        <FieldLabel>{intl.formatMessage({ id: 'agents.technical.preset.label' })}</FieldLabel>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {TECHNICAL_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              style={cardStyle(value.preset === preset.id)}
              onClick={() => handlePreset(preset.id)}
              aria-pressed={value.preset === preset.id}
            >
              <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--color-text-primary)', marginBottom: '2px' }}>
                {intl.formatMessage({ id: preset.labelKey })}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', lineHeight: '1.4' }}>
                {intl.formatMessage({ id: preset.descriptionKey })}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Discovery filters */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px', border: '1px solid var(--color-border)', borderRadius: '8px' }}>
        <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
          {intl.formatMessage({ id: 'agents.technical.filters.title' })}
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <div style={{ flex: 1 }}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.technical.filters.venue' })}</FieldLabel>
            <select
              value={value.filters.venue}
              onChange={(e) => {
                const venue = e.target.value;
                const venueType = venue === 'hyperliquid' ? 'orderbook' : venue === 'jupiter' ? 'swap' : '';
                setFilters({ venue, venueType: venueType as TechnicalConfigFormState['filters']['venueType'] });
              }}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="">{intl.formatMessage({ id: 'agents.technical.filters.venue.placeholder' })}</option>
              <option value="hyperliquid">{intl.formatMessage({ id: 'agents.technical.filters.venue.hyperliquid' })}</option>
              <option value="jupiter">{intl.formatMessage({ id: 'agents.technical.filters.venue.jupiter' })}</option>
            </select>
            {showErrors && !value.filters.venue && (
              <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--color-error, #ef4444)' }}>
                {intl.formatMessage({ id: 'agents.technical.filters.venue.required' })}
              </p>
            )}
          </div>
          <div style={{ flex: 1 }}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.technical.filters.venueType' })}</FieldLabel>
            <input
              style={{ ...inputStyle, background: 'var(--color-surface-2, var(--color-surface-1))' }}
              value={value.filters.venueType}
              readOnly
              placeholder={intl.formatMessage({ id: 'agents.technical.filters.venueTypeAuto' })}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <div style={{ flex: 1 }}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.technical.filters.minVolume' })}</FieldLabel>
            <input
              style={inputStyle}
              type="number"
              min="0"
              value={value.filters.minVolume24hUsd}
              onChange={(e) => setFilters({ minVolume24hUsd: e.target.value })}
              placeholder={intl.formatMessage({ id: 'common.optional' })}
            />
          </div>
          {value.filters.venueType === 'swap' && (
            <div style={{ flex: 1 }}>
              <FieldLabel>{intl.formatMessage({ id: 'agents.technical.filters.minLiquidity' })}</FieldLabel>
              <input
                style={inputStyle}
                type="number"
                min="0"
                value={value.filters.minLiquidityUsd}
                onChange={(e) => setFilters({ minLiquidityUsd: e.target.value })}
                placeholder={intl.formatMessage({ id: 'common.optional' })}
              />
            </div>
          )}
        </div>

        <div>
          <FieldLabel>{intl.formatMessage({ id: 'agents.technical.filters.symbols' })}</FieldLabel>
          <input
            style={inputStyle}
            value={value.filters.symbols.join(', ')}
            onChange={(e) => setFilters({ symbols: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            placeholder={intl.formatMessage({ id: 'agents.technical.filters.symbolsHelp' })}
          />
        </div>

        <div>
          <FieldLabel>{intl.formatMessage({ id: 'agents.technical.filters.excludeSymbols' })}</FieldLabel>
          <input
            style={inputStyle}
            value={value.filters.excludeSymbols.join(', ')}
            onChange={(e) => setFilters({ excludeSymbols: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            placeholder={intl.formatMessage({ id: 'common.optional' })}
          />
        </div>

        {value.filters.venueType === 'swap' && (
          <div>
            <FieldLabel>{intl.formatMessage({ id: 'agents.technical.filters.networks' })}</FieldLabel>
            <input
              style={inputStyle}
              value={value.filters.networks.join(', ')}
              onChange={(e) => setFilters({ networks: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder={intl.formatMessage({ id: 'common.optional' })}
            />
          </div>
        )}
      </div>

      {/* Scan settings — collapsible */}
      <div style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '0 12px' }}>
        {sectionHeader(intl.formatMessage({ id: 'agents.technical.scan.title' }), showScanSettings, () => setShowScanSettings((v) => !v))}
        {showScanSettings && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', paddingBottom: '12px' }}>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ flex: 1 }}>
                <FieldLabel>{intl.formatMessage({ id: 'agents.technical.scan.interval' })}</FieldLabel>
                <input
                  style={inputStyle}
                  type="number"
                  min="1"
                  value={value.scanIntervalMins}
                  onChange={(e) => set({ scanIntervalMins: e.target.value })}
                />
              </div>
              <div style={{ flex: 1 }}>
                <FieldLabel>{intl.formatMessage({ id: 'agents.technical.scan.batchSize' })}</FieldLabel>
                <input
                  style={inputStyle}
                  type="number"
                  min="1"
                  max="50"
                  value={value.scanBatchSize}
                  onChange={(e) => set({ scanBatchSize: e.target.value })}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ flex: 1 }}>
                <FieldLabel>{intl.formatMessage({ id: 'agents.technical.scan.candleInterval' })}</FieldLabel>
                <select
                  style={{ ...inputStyle, cursor: 'pointer' }}
                  value={value.candles.interval}
                  onChange={(e) => set({ candles: { ...value.candles, interval: e.target.value as TechnicalConfigFormState['candles']['interval'] } })}
                >
                  <option value="5m">5m</option>
                  <option value="15m">15m</option>
                  <option value="1H">1H</option>
                  <option value="4H">4H</option>
                  <option value="1D">1D</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <FieldLabel>{intl.formatMessage({ id: 'agents.technical.scan.candleLimit' })}</FieldLabel>
                <input
                  style={inputStyle}
                  type="number"
                  min="20"
                  max="500"
                  value={value.candles.limit}
                  onChange={(e) => set({ candles: { ...value.candles, limit: e.target.value } })}
                />
              </div>
            </div>
            <div>
              <FieldLabel>{intl.formatMessage({ id: 'agents.technical.scan.signalBias' })}</FieldLabel>
              <div style={{ display: 'flex', gap: '8px' }}>
                {(['trend-following', 'mean-reverting'] as const).map((bias) => (
                  <button
                    key={bias}
                    type="button"
                    onClick={() => set({ signalBias: bias })}
                    style={{
                      flex: 1,
                      padding: '8px',
                      borderRadius: '6px',
                      border: `1px solid ${value.signalBias === bias ? 'var(--color-brand)' : 'var(--color-border)'}`,
                      background: value.signalBias === bias ? 'var(--color-brand-subtle, rgba(99,102,241,0.06))' : 'transparent',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: 'var(--color-text-primary)',
                    }}
                    aria-pressed={value.signalBias === bias}
                  >
                    {intl.formatMessage({ id: `agents.technical.scan.signalBias.${bias === 'trend-following' ? 'trendFollowing' : 'meanReverting'}` })}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Indicator toggles — collapsible */}
      <div style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '0 12px' }}>
        {sectionHeader(intl.formatMessage({ id: 'agents.technical.indicators.title' }), showIndicators, () => setShowIndicators((v) => !v))}
        {showIndicators && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingBottom: '12px' }}>
            <IndicatorRow
              slug="rsi"
              label={intl.formatMessage({ id: 'agents.technical.indicators.rsi' })}
              enabled={value.indicators.rsi.enabled}
              onToggle={(enabled) => setIndicators({ rsi: { ...value.indicators.rsi, enabled } })}
            >
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.period' })} value={value.indicators.rsi.period} type="int" onChange={(v) => setIndicators({ rsi: { ...value.indicators.rsi, period: v } })} />
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.healthyMin' })} value={value.indicators.rsi.healthyMin} onChange={(v) => setIndicators({ rsi: { ...value.indicators.rsi, healthyMin: v } })} />
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.healthyMax' })} value={value.indicators.rsi.healthyMax} onChange={(v) => setIndicators({ rsi: { ...value.indicators.rsi, healthyMax: v } })} />
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.overbought' })} value={value.indicators.rsi.overbought} onChange={(v) => setIndicators({ rsi: { ...value.indicators.rsi, overbought: v } })} />
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.oversold' })} value={value.indicators.rsi.weakBelow} onChange={(v) => setIndicators({ rsi: { ...value.indicators.rsi, weakBelow: v } })} />
              </div>
            </IndicatorRow>

            <IndicatorRow
              slug="macd"
              label={intl.formatMessage({ id: 'agents.technical.indicators.macd' })}
              enabled={value.indicators.macd.enabled}
              onToggle={(enabled) => setIndicators({ macd: { ...value.indicators.macd, enabled } })}
            >
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.fast' })} value={value.indicators.macd.fast} type="int" onChange={(v) => setIndicators({ macd: { ...value.indicators.macd, fast: v } })} />
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.slow' })} value={value.indicators.macd.slow} type="int" onChange={(v) => setIndicators({ macd: { ...value.indicators.macd, slow: v } })} />
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.signal' })} value={value.indicators.macd.signal} type="int" onChange={(v) => setIndicators({ macd: { ...value.indicators.macd, signal: v } })} />
              </div>
            </IndicatorRow>

            <IndicatorRow
              slug="volume"
              label={intl.formatMessage({ id: 'agents.technical.indicators.volume' })}
              enabled={value.indicators.volume.enabled}
              onToggle={(enabled) => setIndicators({ volume: { ...value.indicators.volume, enabled } })}
            >
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.strongRatio' })} value={value.indicators.volume.strongRatio} onChange={(v) => setIndicators({ volume: { ...value.indicators.volume, strongRatio: v } })} />
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.weakRatio' })} value={value.indicators.volume.weakRatio} onChange={(v) => setIndicators({ volume: { ...value.indicators.volume, weakRatio: v } })} />
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.recentBars' })} value={value.indicators.volume.recentBars} type="int" onChange={(v) => setIndicators({ volume: { ...value.indicators.volume, recentBars: v } })} />
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.avgBars' })} value={value.indicators.volume.avgBars} type="int" onChange={(v) => setIndicators({ volume: { ...value.indicators.volume, avgBars: v } })} />
              </div>
            </IndicatorRow>

            <IndicatorRow
              slug="supportResistance"
              label={intl.formatMessage({ id: 'agents.technical.indicators.supportResistance' })}
              enabled={value.indicators.supportResistance.enabled}
              onToggle={(enabled) => setIndicators({ supportResistance: { ...value.indicators.supportResistance, enabled } })}
            >
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.lookback' })} value={value.indicators.supportResistance.lookback} type="int" onChange={(v) => setIndicators({ supportResistance: { ...value.indicators.supportResistance, lookback: v } })} />
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.breakoutThreshold' })} value={value.indicators.supportResistance.breakoutThreshold} onChange={(v) => setIndicators({ supportResistance: { ...value.indicators.supportResistance, breakoutThreshold: v } })} />
              </div>
            </IndicatorRow>

            <IndicatorRow
              slug="choch"
              label={intl.formatMessage({ id: 'agents.technical.indicators.choch' })}
              enabled={value.indicators.choch.enabled}
              onToggle={(enabled) => setIndicators({ choch: { ...value.indicators.choch, enabled } })}
            >
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.swingLookback' })} value={value.indicators.choch.swingLookback} type="int" onChange={(v) => setIndicators({ choch: { ...value.indicators.choch, swingLookback: v } })} />
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.minSwingPct' })} value={value.indicators.choch.minSwingPct} onChange={(v) => setIndicators({ choch: { ...value.indicators.choch, minSwingPct: v } })} />
                <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.confirmBars' })} value={value.indicators.choch.confirmBars} type="int" onChange={(v) => setIndicators({ choch: { ...value.indicators.choch, confirmBars: v } })} />
              </div>
              <div style={{ marginTop: '6px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={value.indicators.choch.rejectOnBearish}
                    onChange={(e) => setIndicators({ choch: { ...value.indicators.choch, rejectOnBearish: e.target.checked } })}
                  />
                  {intl.formatMessage({ id: 'agents.technical.params.rejectOnBearish' })}
                </label>
              </div>
            </IndicatorRow>
          </div>
        )}
      </div>

      {/* Confidence weights — collapsible, pre-collapsed */}
      <div style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '0 12px' }}>
        {sectionHeader(intl.formatMessage({ id: 'agents.technical.confidence.title' }), showConfidence, () => setShowConfidence((v) => !v))}
        {showConfidence && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', paddingBottom: '12px' }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.rsiWeight' })} value={value.confidence.rsiWeight} onChange={(v) => setConfidence({ rsiWeight: v })} />
              <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.macdCrossoverWeight' })} value={value.confidence.macdCrossoverWeight} onChange={(v) => setConfidence({ macdCrossoverWeight: v })} />
              <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.macdIncreasingWeight' })} value={value.confidence.macdIncreasingWeight} onChange={(v) => setConfidence({ macdIncreasingWeight: v })} />
              <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.volumeWeight' })} value={value.confidence.volumeWeight} onChange={(v) => setConfidence({ volumeWeight: v })} />
              <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.breakoutWeight' })} value={value.confidence.breakoutWeight} onChange={(v) => setConfidence({ breakoutWeight: v })} />
              <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.priceActionWeight' })} value={value.confidence.priceActionWeight} onChange={(v) => setConfidence({ priceActionWeight: v })} />
              <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.chochBullishWeight' })} value={value.confidence.chochBullishWeight} onChange={(v) => setConfidence({ chochBullishWeight: v })} />
              <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.chochPenalty' })} value={value.confidence.chochBearishPenalty} onChange={(v) => setConfidence({ chochBearishPenalty: v })} />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.minConfidence' })} value={value.confidence.minConfidence} onChange={(v) => setConfidence({ minConfidence: v })} />
              <ParamInput label={intl.formatMessage({ id: 'agents.technical.params.minReasons' })} value={value.confidence.minReasons} type="int" onChange={(v) => setConfidence({ minReasons: v })} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function IndicatorRow({
  slug,
  label,
  enabled,
  onToggle,
  children,
}: {
  slug: string;
  label: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ borderBottom: '1px solid var(--color-border-subtle)', paddingBottom: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: enabled ? '8px' : 0 }}>
        <input
          type="checkbox"
          id={`ind-${slug}`}
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          style={{ cursor: 'pointer' }}
        />
        <label
          htmlFor={`ind-${slug}`}
          style={{ fontSize: '13px', fontWeight: '500', color: 'var(--color-text-primary)', cursor: 'pointer' }}
        >
          {label}
        </label>
      </div>
      {enabled && children}
    </div>
  );
}

function ParamInput({
  label,
  value,
  onChange,
  type = 'float',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: 'float' | 'int';
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '100px' }}>
      <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{label}</div>
      <input
        style={{ ...inputStyle, padding: '5px 8px', fontSize: '13px' }}
        type="number"
        step={type === 'int' ? '1' : 'any'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

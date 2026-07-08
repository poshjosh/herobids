import { useState } from 'react';
import { useIntl } from 'react-intl';
import { FieldLabel, inputStyle } from '../../lib/ui.js';
import { type AgentStyleValue, type RuntimePolicyOverrides, resolveStyleDefaults, type TradingSessionName } from './style-mapping.js';
import { MS_PER_MINUTE } from './tick-interval.js';

interface RuntimePolicySectionProps {
  style: AgentStyleValue;
  overrides: RuntimePolicyOverrides | null;
  onChange: (overrides: RuntimePolicyOverrides | null) => void;
  /** When true, renders the section fully expanded without a click-to-open link. */
  alwaysExpanded?: boolean;
  /** When true, shows trading-session preset shortcuts above the hour grid. */
  showTradingSessionPresets?: boolean;
}

type NumericField = Exclude<keyof RuntimePolicyOverrides, 'allowedHoursUtc' | 'weekendPause' | 'tradingSessions'>;

const NUMERIC_FIELDS: NumericField[] = [
  'scoutMaxTurns',
  'judgeMaxTurns',
  'scoutMaxTokens',
  'judgeMaxTokens',
  'lightThinkingTokens',
  'deepThinkingTokens',
  'maxHistoryMessages',
  'maxHistoryTokens',
  'maxRecentToolMessages',
  'maxToolResultChars',
  'maxVisibleToolSchemas',
  'maxContextBlockChars',
  'toolResultFullRetentionTurns',
  'toolResultMaxStaleChars',
  'maxHoldDurationMs',
];

const SESSION_LOCAL_HOURS: Record<TradingSessionName, number[]> = {
  'asia':         [20, 21, 22, 23],
  'london':       [1, 2, 3, 4],
  'ny-morning':   [7, 8, 9],
  'ny-mid':       [10, 11],
  'ny-afternoon': [12, 13, 14, 15],
};

function previewHoursForSessions(sessions: TradingSessionName[]): number[] {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false,
  }).formatToParts(now);
  const hourPart = parts.find(p => p.type === 'hour');
  if (!hourPart) return [];
  const nyHour = parseInt(hourPart.value, 10);
  const offset = (now.getUTCHours() - nyHour + 24) % 24;
  const set = new Set<number>();
  for (const s of sessions) {
    for (const h of SESSION_LOCAL_HOURS[s]!) set.add((h + offset) % 24);
  }
  return [...set].sort((a, b) => a - b);
}

/** 24-hour checkbox grid for selecting active hours */
function HourGrid({
  selected,
  onChange,
  defaultHours,
  isPreview,
  previewNote,
}: {
  selected: number[] | null | undefined;
  onChange: (hours: number[] | null) => void;
  defaultHours: number[];
  isPreview?: boolean;
  previewNote?: string;
}) {
  const active = selected ?? defaultHours;
  const isCustom = selected != null;

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', marginTop: '4px' }}>
        {Array.from({ length: 24 }, (_, h) => {
          const checked = active.includes(h);
          return (
            <label
              key={h}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '32px',
                height: '28px',
                borderRadius: '4px',
                fontSize: '11px',
                cursor: isPreview ? 'default' : 'pointer',
                background: checked ? 'var(--color-brand)' : 'var(--color-surface-2)',
                color: checked
                  ? '#fff'
                  : isPreview && !checked
                    ? 'var(--color-text-disabled)'
                    : 'var(--color-text-secondary)',
                border: `1px solid ${checked ? 'var(--color-brand)' : 'var(--color-border)'}`,
                transition: 'background 0.1s, color 0.1s',
                userSelect: 'none',
                pointerEvents: isPreview ? 'none' : undefined,
                opacity: isPreview ? 0.7 : undefined,
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={isPreview ? undefined : () => {
                  const next = checked
                    ? active.filter((v) => v !== h)
                    : [...active, h].sort((a, b) => a - b);
                  // If result matches defaults, clear override
                  const sorted = next.length > 0 ? next : [];
                  const matchesDefault =
                    sorted.length === defaultHours.length &&
                    sorted.every((v, i) => v === defaultHours[i]);
                  onChange(matchesDefault ? null : sorted);
                }}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
              />
              {h}
            </label>
          );
        })}
      </div>
      {!isPreview && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '4px', fontSize: '11px', color: 'var(--color-text-muted)' }}>
          <span>{isCustom ? 'Custom hours' : 'Style default'}</span>
          {isCustom && (
            <button
              type="button"
              onClick={() => onChange(null)}
              style={{
                background: 'none',
                border: 'none',
                padding: '0',
                cursor: 'pointer',
                color: 'var(--color-accent)',
                fontSize: '11px',
                textDecoration: 'underline',
              }}
            >
              Reset to default
            </button>
          )}
        </div>
      )}
      {isPreview && previewNote && (
        <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--color-text-muted)' }}>
          {previewNote}
        </div>
      )}
    </div>
  );
}

export function RuntimePolicySection({ style, overrides, onChange, alwaysExpanded, showTradingSessionPresets }: RuntimePolicySectionProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(alwaysExpanded ?? false);

  const defaults = resolveStyleDefaults(style);

  function setOverride<K extends keyof RuntimePolicyOverrides>(
    field: K,
    value: RuntimePolicyOverrides[K],
  ) {
    const current = overrides ?? {};
    const next: RuntimePolicyOverrides = { ...current, [field]: value };
    onChange(Object.keys(next).length > 0 ? next : null);
  }

  function clearOverride(field: keyof RuntimePolicyOverrides) {
    if (!overrides) return;
    const next = { ...overrides };
    delete next[field];
    onChange(Object.keys(next).length > 0 ? next : null);
  }

  function handleNumericChange(field: NumericField, raw: string) {
    if (raw.trim() === '') {
      clearOverride(field);
      return;
    }
    const n = Number(raw);
    if (!Number.isNaN(n) && Number.isFinite(n) && n >= 0) {
      if (field === 'maxHoldDurationMs') {
        setOverride(field, Math.round(n * MS_PER_MINUTE) as RuntimePolicyOverrides[NumericField]);
        return;
      }
      setOverride(field, n as RuntimePolicyOverrides[NumericField]);
    }
  }

  function getNumericValue(field: NumericField): string {
    const v = overrides?.[field];
    if (field === 'maxHoldDurationMs') {
      return v != null ? String(v / MS_PER_MINUTE) : '';
    }
    return v != null ? String(v) : '';
  }

  function getNumericPlaceholder(field: NumericField): string {
    if (field === 'maxHoldDurationMs') {
      return String(defaults.maxHoldDurationMs / MS_PER_MINUTE);
    }
    return String(defaults[field]);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          background: 'none',
          border: 'none',
          padding: '0',
          cursor: 'pointer',
          color: 'var(--color-accent)',
          fontSize: '13px',
          textDecoration: 'underline',
          marginTop: '4px',
          display: 'block',
        }}
      >
        {intl.formatMessage({ id: 'agents.runtimePolicy.title' })}
        {overrides && Object.keys(overrides).length > 0 ? ' *' : ''}
      </button>
    );
  }

  return (
    <div style={{ marginTop: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontWeight: 600, fontSize: '14px' }}>
          {intl.formatMessage({ id: 'agents.runtimePolicy.title' })}
        </div>
        {!alwaysExpanded && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', color: 'var(--color-text-muted)' }}
          >
            ×
          </button>
        )}
      </div>
      <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '16px' }}>
        {intl.formatMessage({ id: 'agents.runtimePolicy.description' })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        {NUMERIC_FIELDS.map((field) => (
          <div key={field}>
            <FieldLabel htmlFor={`rp-${field}`}>
              {intl.formatMessage({ id: `agents.runtimePolicy.${field}` })}
            </FieldLabel>
            <input
              id={`rp-${field}`}
              type="number"
              min={0}
              step={field === 'maxHoldDurationMs' ? 'any' : undefined}
              style={inputStyle}
              value={getNumericValue(field)}
              placeholder={getNumericPlaceholder(field)}
              onChange={(e) => handleNumericChange(field, e.target.value)}
            />
            {field === 'maxHoldDurationMs' && (
              <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                {intl.formatMessage({ id: 'agents.runtimePolicy.maxHoldDurationHelp' })}
              </div>
            )}
          </div>
        ))}

        {/* weekendPause */}
        <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            id="rp-weekendPause"
            type="checkbox"
            checked={overrides?.weekendPause ?? defaults.weekendPause}
            onChange={(e) => {
              const checked = e.target.checked;
              if (checked === defaults.weekendPause) {
                clearOverride('weekendPause');
              } else {
                setOverride('weekendPause', checked);
              }
            }}
          />
          <label htmlFor="rp-weekendPause" style={{ fontWeight: 600, fontSize: '14px', cursor: 'pointer' }}>
            {intl.formatMessage({ id: 'agents.runtimePolicy.weekendPause' })}
          </label>
        </div>

        {/* allowedHoursUtc */}
        <div style={{ gridColumn: '1 / -1' }}>
          <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '6px' }}>
            {intl.formatMessage({ id: 'agents.runtimePolicy.allowedHoursUtc' })}
            {(() => {
              const activeSessions = overrides?.tradingSessions;
              if (activeSessions && activeSessions.length > 0) {
                return ` ${intl.formatMessage({ id: 'agents.runtimePolicy.sessionPreviewNote' })}`;
              }
              return null;
            })()}
          </div>
          <HourGrid
            selected={(() => {
              const activeSessions = overrides?.tradingSessions;
              if (activeSessions && activeSessions.length > 0) {
                return previewHoursForSessions(activeSessions);
              }
              return overrides?.allowedHoursUtc ?? null;
            })()}
            onChange={(hours) => {
              if (hours === null) {
                clearOverride('allowedHoursUtc');
              } else {
                setOverride('allowedHoursUtc', hours);
              }
            }}
            defaultHours={defaults.allowedHoursUtc}
            isPreview={(() => {
              const activeSessions = overrides?.tradingSessions;
              return showTradingSessionPresets === true && activeSessions != null && activeSessions.length > 0;
            })()}
            previewNote={intl.formatMessage({ id: 'agents.runtimePolicy.sessionPreviewNote' })}
          />
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
            {intl.formatMessage({ id: 'agents.runtimePolicy.allowedHoursUtcHelp' })}
          </div>
        </div>

        {/* Trading Session Presets */}
        {showTradingSessionPresets && (
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '6px' }}>
              {intl.formatMessage({ id: 'agents.runtimePolicy.tradingSessionsLabel' })}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '8px' }}>
              {intl.formatMessage({ id: 'agents.runtimePolicy.tradingSessionsHelp' })}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {([
                { key: 'asia', labelId: 'agents.runtimePolicy.session.asia', subId: 'agents.runtimePolicy.session.asia.subtitle' } as const,
                { key: 'london', labelId: 'agents.runtimePolicy.session.london', subId: 'agents.runtimePolicy.session.london.subtitle' } as const,
                { key: 'ny-morning', labelId: 'agents.runtimePolicy.session.nyMorning', subId: 'agents.runtimePolicy.session.nyMorning.subtitle' } as const,
                { key: 'ny-mid', labelId: 'agents.runtimePolicy.session.nyMid', subId: 'agents.runtimePolicy.session.nyMid.subtitle' } as const,
                { key: 'ny-afternoon', labelId: 'agents.runtimePolicy.session.nyAfternoon', subId: 'agents.runtimePolicy.session.nyAfternoon.subtitle' } as const,
              ]).map(({ key, labelId, subId }) => {
                const sessions = overrides?.tradingSessions ?? [];
                const checked = sessions.includes(key as TradingSessionName);
                return (
                  <label
                    key={key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '6px 10px',
                      border: `1px solid ${checked ? 'var(--color-brand)' : 'var(--color-border)'}`,
                      borderRadius: '6px',
                      cursor: 'pointer',
                      background: checked ? 'var(--color-brand-soft, rgba(59,130,246,0.08))' : 'var(--color-surface-2)',
                      fontSize: '13px',
                      userSelect: 'none',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? sessions.filter(s => s !== key)
                          : [...sessions, key as TradingSessionName];
                        if (next.length === 0) {
                          clearOverride('tradingSessions');
                        } else {
                          const patch: Partial<RuntimePolicyOverrides> = { tradingSessions: next };
                          if (overrides?.allowedHoursUtc != null) {
                            patch.allowedHoursUtc = null;
                          }
                          const current = overrides ?? {};
                          const merged: RuntimePolicyOverrides = { ...current, ...patch };
                          if (patch.allowedHoursUtc === null) delete merged.allowedHoursUtc;
                          onChange(Object.keys(merged).length > 0 ? merged : null);
                        }
                      }}
                      style={{ accentColor: 'var(--color-brand)' }}
                    />
                    <span style={{ fontSize: '12px', fontWeight: '500', color: 'var(--color-text-secondary)' }}>{intl.formatMessage({ id: labelId })}</span>
                    <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: subId })}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

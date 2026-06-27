import { useState } from 'react';
import { useIntl } from 'react-intl';
import { FieldLabel, inputStyle } from '../../lib/ui.js';
import { type AgentStyleValue, type RuntimePolicyOverrides, resolveStyleDefaults } from './style-mapping.js';

interface RuntimePolicySectionProps {
  style: AgentStyleValue;
  overrides: RuntimePolicyOverrides | null;
  onChange: (overrides: RuntimePolicyOverrides | null) => void;
}

type NumericField = Exclude<keyof RuntimePolicyOverrides, 'allowedHoursUtc' | 'weekendPause'>;

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

function parseHoursInput(raw: string): number[] | null {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  const parts = trimmed.split(',').map((s) => s.trim());
  const hours: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 23) return null;
    hours.push(n);
  }
  return hours;
}

export function RuntimePolicySection({ style, overrides, onChange }: RuntimePolicySectionProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [hoursInput, setHoursInput] = useState<string>(() => {
    const v = overrides?.allowedHoursUtc;
    return v != null ? v.join(', ') : '';
  });
  const [hoursError, setHoursError] = useState<string | null>(null);

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
      setOverride(field, n as RuntimePolicyOverrides[NumericField]);
    }
  }

  function getNumericValue(field: NumericField): string {
    const v = overrides?.[field];
    return v != null ? String(v) : '';
  }

  function getNumericPlaceholder(field: NumericField): string {
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
    <div
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: '8px',
        padding: '16px',
        background: 'var(--color-surface-1)',
        marginTop: '8px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontWeight: 600, fontSize: '14px' }}>
          {intl.formatMessage({ id: 'agents.runtimePolicy.title' })}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', color: 'var(--color-text-muted)' }}
        >
          ×
        </button>
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
              style={inputStyle}
              value={getNumericValue(field)}
              placeholder={getNumericPlaceholder(field)}
              onChange={(e) => handleNumericChange(field, e.target.value)}
            />
          </div>
        ))}

        {/* allowedHoursUtc */}
        <div style={{ gridColumn: '1 / -1' }}>
          <FieldLabel htmlFor="rp-allowedHoursUtc">
            {intl.formatMessage({ id: 'agents.runtimePolicy.allowedHoursUtc' })}
          </FieldLabel>
          <input
            id="rp-allowedHoursUtc"
            type="text"
            style={inputStyle}
            value={hoursInput}
            placeholder={defaults.allowedHoursUtc.join(', ') || intl.formatMessage({ id: 'agents.runtimePolicy.allowedHoursUtcHelp' })}
            onChange={(e) => {
              const raw = e.target.value;
              setHoursInput(raw);
              setHoursError(null);
              if (raw.trim() === '') {
                clearOverride('allowedHoursUtc');
                return;
              }
              const parsed = parseHoursInput(raw);
              if (parsed === null) {
                setHoursError(intl.formatMessage({ id: 'agents.runtimePolicy.allowedHoursUtcHelp' }));
              } else {
                setOverride('allowedHoursUtc', parsed);
              }
            }}
          />
          {hoursError && <div style={{ color: 'var(--color-danger)', fontSize: '12px', marginTop: '4px' }}>{hoursError}</div>}
        </div>

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
          <label htmlFor="rp-weekendPause" style={{ fontSize: '13px', cursor: 'pointer' }}>
            {intl.formatMessage({ id: 'agents.runtimePolicy.weekendPause' })}
          </label>
        </div>
      </div>
    </div>
  );
}

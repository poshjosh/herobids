import { useState } from 'react';
import { useIntl } from 'react-intl';
import { FieldLabel, inputStyle } from '../../lib/ui.js';
import { type AgentStyleValue, type RuntimePolicyOverrides, resolveStyleDefaults } from './style-mapping.js';
import { MS_PER_MINUTE } from './tick-interval.js';

interface RuntimePolicySectionProps {
  style: AgentStyleValue;
  overrides: RuntimePolicyOverrides | null;
  onChange: (overrides: RuntimePolicyOverrides | null) => void;
  /** When true, renders the section fully expanded without a click-to-open link. */
  alwaysExpanded?: boolean;
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

/** 24-hour checkbox grid for selecting active hours */
function HourGrid({
  selected,
  onChange,
  defaultHours,
}: {
  selected: number[] | null | undefined;
  onChange: (hours: number[] | null) => void;
  defaultHours: number[];
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
                cursor: 'pointer',
                background: checked ? 'var(--color-brand)' : 'var(--color-surface-2)',
                color: checked ? '#fff' : 'var(--color-text-secondary)',
                border: `1px solid ${checked ? 'var(--color-brand)' : 'var(--color-border)'}`,
                transition: 'background 0.1s, color 0.1s',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => {
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
    </div>
  );
}

export function RuntimePolicySection({ style, overrides, onChange, alwaysExpanded }: RuntimePolicySectionProps) {
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

        {/* allowedHoursUtc */}
        <div style={{ gridColumn: '1 / -1' }}>
          <FieldLabel htmlFor="rp-allowedHoursUtc">
            {intl.formatMessage({ id: 'agents.runtimePolicy.allowedHoursUtc' })}
          </FieldLabel>
          <HourGrid
            selected={overrides?.allowedHoursUtc ?? null}
            onChange={(hours) => {
              if (hours === null) {
                clearOverride('allowedHoursUtc');
              } else {
                setOverride('allowedHoursUtc', hours);
              }
            }}
            defaultHours={defaults.allowedHoursUtc}
          />
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
            {intl.formatMessage({ id: 'agents.runtimePolicy.allowedHoursUtcHelp' })}
          </div>
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

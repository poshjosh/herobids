import { type ReactNode, useState, useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';

export interface AdvancedSettingsSectionProps {
  aiConfig: ReactNode;
  tradingSetup: ReactNode;
  strategy: ReactNode;
  /** Called when the section is expanded or collapsed. */
  onToggle?: (open: boolean) => void;
  /**
   * Increment to force-expand the section and switch to the error tab.
   * Using a counter (not a boolean) ensures the effect fires even when the
   * section was already open or errors pre-existed from a prior onBlur.
   */
  expandSeq?: number;
  /** Tab index to switch to when expandSeq fires (0=AI, 1=Trading). */
  errorTabIdx?: number;
  /** Form validation errors keyed by field name. Used to highlight error tabs. */
  formErrors?: Record<string, string>;
  /** Maps validated field names to the tab index that contains them. */
  fieldTabMap?: Record<string, number>;
}

const wrapperStyle: React.CSSProperties = {};

const summaryStyle: React.CSSProperties = {
  padding: '12px 0',
  cursor: 'pointer',
  fontSize: '0.875rem',
  fontWeight: '600',
  color: 'var(--color-text-secondary)',
  userSelect: 'none',
};

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0',
  borderBottom: '1px solid var(--color-border)',
  overflowX: 'auto',
  whiteSpace: 'nowrap',
  WebkitOverflowScrolling: 'touch',
};

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: '10px 16px',
  fontSize: '0.875rem',
  fontWeight: active ? '600' : '500',
  color: 'var(--color-text-primary)',
  background: 'none',
  border: 'none',
  borderBottom: active ? '2px solid var(--color-brand)' : '2px solid transparent',
  cursor: 'pointer',
  marginBottom: '-1px',
});

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  padding: '16px 0',
};

const sectionLabels = [
  'agents.advanced.aiConfig',
  'agents.advanced.tradingSetup',
  'agents.advanced.strategy',
] as const;

export function AdvancedSettingsSection({
  aiConfig,
  tradingSetup,
  strategy,
  onToggle,
  expandSeq,
  errorTabIdx,
  formErrors,
  fieldTabMap,
}: AdvancedSettingsSectionProps) {
  const intl = useIntl();
  const slots = [aiConfig, tradingSetup, strategy];

  const visibleTabs = slots
    .map((slot, idx) => ({ slot, idx }))
    .filter(({ slot }) => slot != null && slot !== false);

  // Compute which tabs have errors
  const errorTabIndices = new Set<number>();
  if (formErrors && fieldTabMap) {
    for (const fieldName of Object.keys(formErrors)) {
      const tabIdx = fieldTabMap[fieldName];
      if (tabIdx !== undefined && slots[tabIdx] != null && slots[tabIdx] !== false) {
        errorTabIndices.add(tabIdx);
      }
    }
  }

  const [activeIdx, setActiveIdx] = useState(() => visibleTabs.length > 0 ? visibleTabs[0]!.idx : 0);
  const [userOpen, setUserOpen] = useState(false);
  const lastSeq = useRef(0);

  // Expand and switch tab whenever a new error sequence is triggered.
  // Using a counter guarantees the effect fires even when errors already
  // existed from a prior onBlur (i.e. expandSeq was already > 0).
  useEffect(() => {
    const seq = expandSeq ?? 0;
    if (seq > 0 && seq !== lastSeq.current) {
      lastSeq.current = seq;
      setUserOpen(true);
      onToggle?.(true);
      if (errorTabIdx !== undefined) {
        setActiveIdx(errorTabIdx);
      }
    }
  }, [expandSeq, errorTabIdx, onToggle]);

  // If active tab is no longer visible, fall back to first visible
  const resolvedIdx = visibleTabs.some(({ idx }) => idx === activeIdx)
    ? activeIdx
    : visibleTabs.length > 0 ? visibleTabs[0]!.idx : 0;

  if (visibleTabs.length === 0) return null;

  return (
      <details style={wrapperStyle} open={userOpen} onToggle={(e) => {
        const open = (e.currentTarget as HTMLDetailsElement).open;
        setUserOpen(open);
        onToggle?.(open);
      }}>
      <summary style={summaryStyle}>
        {intl.formatMessage({ id: 'agents.create.advancedSettings' })}
      </summary>
      <div>
        <div style={tabBarStyle} role="tablist">
          {visibleTabs.map(({ idx }) => {
            const hasError = errorTabIndices.has(idx);
            const active = idx === resolvedIdx;
            return (
              <button
                key={sectionLabels[idx]}
                type="button"
                role="tab"
                aria-selected={active}
                style={{
                  ...tabStyle(active),
                  ...(hasError ? { color: 'var(--color-danger)' } : {}),
                }}
                onClick={() => setActiveIdx(idx)}
              >
                {hasError && (
                  <span style={{ marginRight: '4px', fontSize: '0.625rem' }}>●</span>
                )}
                {intl.formatMessage({ id: sectionLabels[idx] })}
              </button>
            );
          })}
        </div>
        <div role="tabpanel" style={panelStyle}>
          {slots[resolvedIdx]}
        </div>
      </div>
    </details>
  );
}

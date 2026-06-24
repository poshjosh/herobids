import { type ReactNode, useState, useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';

export interface AdvancedSettingsSectionProps {
  aiConfig: ReactNode;
  skills: ReactNode;
  tradingSetup: ReactNode;
  strategy: ReactNode;
  /**
   * Increment to force-expand the section and switch to the error tab.
   * Using a counter (not a boolean) ensures the effect fires even when the
   * section was already open or errors pre-existed from a prior onBlur.
   */
  expandSeq?: number;
  /** Tab index to switch to when expandSeq fires (0=AI, 2=Trading). */
  errorTabIdx?: number;
}

const wrapperStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: '8px',
  background: 'var(--color-surface-1)',
};

const summaryStyle: React.CSSProperties = {
  padding: '12px 16px',
  cursor: 'pointer',
  fontSize: '14px',
  fontWeight: '600',
  color: 'var(--color-text-secondary)',
  userSelect: 'none',
};

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0',
  borderBottom: '1px solid var(--color-border)',
  padding: '0 16px',
};

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: '8px 16px',
  fontSize: '13px',
  fontWeight: active ? '600' : '400',
  color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
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
  padding: '16px',
};

const sectionLabels = [
  'agents.advanced.aiConfig',
  'agents.advanced.skills',
  'agents.advanced.tradingSetup',
  'agents.advanced.strategy',
] as const;

export function AdvancedSettingsSection({
  aiConfig,
  skills,
  tradingSetup,
  strategy,
  expandSeq,
  errorTabIdx,
}: AdvancedSettingsSectionProps) {
  const intl = useIntl();
  const slots = [aiConfig, skills, tradingSetup, strategy];

  const visibleTabs = slots
    .map((slot, idx) => ({ slot, idx }))
    .filter(({ slot }) => slot != null && slot !== false);

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
      if (errorTabIdx !== undefined) {
        setActiveIdx(errorTabIdx);
      }
    }
  }, [expandSeq, errorTabIdx]);

  // If active tab is no longer visible, fall back to first visible
  const resolvedIdx = visibleTabs.some(({ idx }) => idx === activeIdx)
    ? activeIdx
    : visibleTabs.length > 0 ? visibleTabs[0]!.idx : 0;

  if (visibleTabs.length === 0) return null;

  return (
    <details style={wrapperStyle} open={userOpen} onToggle={(e) => setUserOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary style={summaryStyle}>
        {intl.formatMessage({ id: 'agents.create.advancedSettings' })}
      </summary>
      <div>
        <div style={tabBarStyle} role="tablist">
          {visibleTabs.map(({ idx }) => (
            <button
              key={sectionLabels[idx]}
              type="button"
              role="tab"
              aria-selected={idx === resolvedIdx}
              style={tabStyle(idx === resolvedIdx)}
              onClick={() => setActiveIdx(idx)}
            >
              {intl.formatMessage({ id: sectionLabels[idx] })}
            </button>
          ))}
        </div>
        <div role="tabpanel" style={panelStyle}>
          {slots[resolvedIdx]}
        </div>
      </div>
    </details>
  );
}

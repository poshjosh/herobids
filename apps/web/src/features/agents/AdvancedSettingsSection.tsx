import { type ReactNode } from 'react';
import { useIntl } from 'react-intl';

export interface AdvancedSettingsSectionProps {
  aiConfig: ReactNode;
  skills: ReactNode;
  tradingSetup: ReactNode;
  strategy: ReactNode;
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
};

const detailsStyle: React.CSSProperties = {
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

const bodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  padding: '0 16px 16px 16px',
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
}: AdvancedSettingsSectionProps) {
  const intl = useIntl();
  const slots = [aiConfig, skills, tradingSetup, strategy];

  const nonEmptySlots = slots
    .map((slot, idx) => ({ slot, idx }))
    .filter(({ slot }) => slot != null && slot !== false);

  const firstVisibleIndex = nonEmptySlots.length > 0 ? nonEmptySlots[0]!.idx : -1;

  return (
    <div style={containerStyle}>
      {slots.map((slot, index) => {
        // Skip rendering a section if its slot is null/undefined/empty
        if (slot == null || slot === false) return null;

        return (
          <details key={sectionLabels[index]} style={detailsStyle} open={index === firstVisibleIndex}>
            <summary style={summaryStyle}>
              {intl.formatMessage({ id: sectionLabels[index] })}
            </summary>
            <div style={bodyStyle}>{slot}</div>
          </details>
        );
      })}
    </div>
  );
}

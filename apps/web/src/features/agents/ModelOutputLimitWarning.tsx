import { useIntl } from 'react-intl';
import { findModelOutputLimitShortfalls, type AgentStyleValue, type RuntimePolicyOverrides } from './style-mapping.js';

interface ModelOutputLimitWarningProps {
  style: AgentStyleValue;
  overrides: RuntimePolicyOverrides | null | undefined;
  lightModel: string | null | undefined;
  heavyModel: string | null | undefined;
}

const ROLE_LABEL_KEYS = {
  scout: 'aiModels.economy.label',
  judge: 'aiModels.premium.label',
} as const;

/** Non-blocking notice when a selected model cannot write the output the agent's style needs (D21 C). */
export function ModelOutputLimitWarning({ style, overrides, lightModel, heavyModel }: ModelOutputLimitWarningProps) {
  const intl = useIntl();
  const shortfalls = findModelOutputLimitShortfalls({ style, overrides, lightModel, heavyModel });
  if (shortfalls.length === 0) return null;

  const styleLabel = intl.formatMessage({ id: `agents.style.${style}.label` });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {shortfalls.map((shortfall) => (
        <div
          key={shortfall.role}
          role="status"
          data-testid={`model-output-limit-warning-${shortfall.role}`}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            padding: '10px 14px',
            borderRadius: '6px',
            background: 'var(--color-warning-subtle)',
            border: '1px solid var(--color-warning)',
            color: 'var(--color-warning)',
            fontSize: '0.8125rem',
            lineHeight: '1.5',
          }}
        >
          <span aria-hidden="true">⚠</span>
          <span>
            <strong>{intl.formatMessage({ id: ROLE_LABEL_KEYS[shortfall.role] })}:</strong>{' '}
            {intl.formatMessage(
              { id: 'agents.models.outputLimitWarning' },
              {
                max: intl.formatNumber(shortfall.maxOutputTokens),
                style: styleLabel,
                level: intl.formatMessage({ id: `aiModels.reasoning.${shortfall.reasoning}` }),
                required: intl.formatNumber(shortfall.requiredTokens),
              },
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

import { useIntl } from 'react-intl';

export interface ChildGrantScope {
  grantAnySkillToChildren: boolean;
  grantAnyConnectionToChildren: boolean;
}

interface ChildGrantScopeFieldsProps {
  /** Prefix that keeps element ids unique when the fields render more than once on a page. */
  idPrefix: string;
  value: ChildGrantScope;
  onChange: (next: ChildGrantScope) => void;
  disabled?: boolean;
  /** Id(s) of surrounding explanatory text that describes the whole group. */
  describedBy?: string;
}

const LABEL_STYLE = { display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '0.8125rem', cursor: 'pointer' } as const;
const HINT_STYLE = { fontSize: '0.8125rem', color: 'var(--color-text-secondary)', lineHeight: '1.5', marginLeft: '24px' } as const;

/** The two user-set switches that let an agent give children skills and connections it does not hold. */
export function ChildGrantScopeFields({ idPrefix, value, onChange, disabled = false, describedBy }: ChildGrantScopeFieldsProps) {
  const intl = useIntl();
  const skillId = `${idPrefix}-grant-any-skill`;
  const connectionId = `${idPrefix}-grant-any-connection`;
  const warningId = `${connectionId}-warning`;

  return (
    <fieldset
      aria-describedby={describedBy}
      style={{ display: 'flex', flexDirection: 'column', gap: '8px', border: 'none', margin: 0, padding: 0, minWidth: 0 }}
    >
      <legend style={{ fontSize: '0.8125rem', fontWeight: 600, padding: 0, marginBottom: '8px' }}>
        {intl.formatMessage({ id: 'agents.allowance.grantScopeLegend' })}
      </legend>
      <label htmlFor={skillId} style={LABEL_STYLE}>
        <input
          id={skillId}
          type="checkbox"
          checked={value.grantAnySkillToChildren}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, grantAnySkillToChildren: event.target.checked })}
        />
        <span>{intl.formatMessage({ id: 'agents.allowance.grantSkills' })}</span>
      </label>
      <label htmlFor={connectionId} style={LABEL_STYLE}>
        <input
          id={connectionId}
          type="checkbox"
          checked={value.grantAnyConnectionToChildren}
          disabled={disabled}
          aria-describedby={warningId}
          onChange={(event) => onChange({ ...value, grantAnyConnectionToChildren: event.target.checked })}
        />
        <span>{intl.formatMessage({ id: 'agents.allowance.grantConnections' })}</span>
      </label>
      <div id={warningId} style={{ ...HINT_STYLE, color: 'var(--color-warning)' }}>
        {intl.formatMessage({ id: 'agents.allowance.grantConnectionsWarning' })}
      </div>
    </fieldset>
  );
}

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, type Agent } from '../../lib/api-client.js';
import { Card, Button, ErrorBanner, FieldLabel, LoadingRows, SECTION_TITLE_STYLE, inputStyle } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { ChildGrantScopeFields, type ChildGrantScope } from './ChildGrantScopeFields.js';

const SCOPE_NOTE_ID = 'child-allowance-scope-note';
const SCOPE_INACTIVE_ID = 'child-allowance-scope-inactive';

interface AllowanceSave {
  /** Set when the limit changed. */
  limit?: number;
  /** Set when either grant flag changed. */
  scope?: ChildGrantScope;
}

interface ChildAgentAllowanceCardProps {
  agent: Agent;
  /** Plan ceiling for childAgentLimit. The card is hidden when this is 0. */
  ceiling: number;
}

export function ChildAgentAllowanceCard({ agent, ceiling }: ChildAgentAllowanceCardProps) {
  const intl = useIntl();
  const qc = useQueryClient();
  // null means the field shows the saved limit; a string is an unsaved edit.
  const [draft, setDraft] = useState<string | null>(null);
  // Same idea for the two grant flags: null shows the saved values.
  const [scopeDraft, setScopeDraft] = useState<ChildGrantScope | null>(null);

  const allowanceQuery = useQuery({
    queryKey: ['agents', agent.id, 'child-allowance'],
    queryFn: () => agentsApi.childAllowance(agent.id),
    enabled: ceiling > 0,
  });

  const saveMutation = useMutation({
    mutationFn: async ({ limit, scope }: AllowanceSave) => {
      if (limit !== undefined) await agentsApi.setChildLimit(agent.id, limit);
      if (scope !== undefined) await agentsApi.setChildGrantScope(agent.id, scope);
    },
    onSettled: () => {
      // Refresh even on failure: the limit may have saved before the scope call failed.
      // The ['agents'] prefix also covers this agent's child-allowance query.
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onSuccess: () => {
      setDraft(null);
      setScopeDraft(null);
    },
  });

  if (ceiling <= 0) return null;

  const allowance = allowanceQuery.data;
  const shownValue = draft ?? String(allowance?.childAgentLimit ?? 0);
  const parsedLimit = Number(shownValue);
  const isValidLimit = shownValue.trim() !== '' && Number.isInteger(parsedLimit) && parsedLimit >= 0 && parsedLimit <= ceiling;
  const isBelowChildCount = isValidLimit && allowance !== undefined && parsedLimit < allowance.childCount;
  const savedScope: ChildGrantScope = {
    grantAnySkillToChildren: allowance?.grantAnySkillToChildren ?? false,
    grantAnyConnectionToChildren: allowance?.grantAnyConnectionToChildren ?? false,
  };
  const shownScope = scopeDraft ?? savedScope;
  const isLimitChanged = allowance !== undefined && isValidLimit && parsedLimit !== allowance.childAgentLimit;
  // Saved flags stay visible (and revocable) even while the limit is 0.
  const hasSavedFlag = savedScope.grantAnySkillToChildren || savedScope.grantAnyConnectionToChildren;
  const isLimitAboveZero = isValidLimit && parsedLimit > 0;
  const showScopeFields = isLimitAboveZero || hasSavedFlag;
  // Hidden unsaved edits must never be saved.
  const isScopeChanged = showScopeFields && (shownScope.grantAnySkillToChildren !== savedScope.grantAnySkillToChildren
    || shownScope.grantAnyConnectionToChildren !== savedScope.grantAnyConnectionToChildren);

  return (
    <Card>
      <details>
        <summary
          style={{
            ...SECTION_TITLE_STYLE,
            marginBottom: '0',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          {intl.formatMessage({ id: 'agents.allowance.title' })}
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
          <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
            {intl.formatMessage({ id: 'agents.allowance.description' }, { ceiling })}
          </div>

          {allowanceQuery.isLoading && <LoadingRows count={1} />}
          {allowanceQuery.isError && (
            <ErrorBanner message={localizeApiError(intl, allowanceQuery.error, 'common.errorTitle')} />
          )}
          {saveMutation.isError && (
            <ErrorBanner message={localizeApiError(intl, saveMutation.error, 'common.errorTitle')} />
          )}

          {allowance && (
            <>
              <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                {intl.formatMessage({ id: 'agents.allowance.current' }, { childCount: allowance.childCount })}
              </div>

              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '160px' }}>
                  <FieldLabel htmlFor="child-agent-limit">
                    {intl.formatMessage({ id: 'agents.allowance.limitLabel' })}
                  </FieldLabel>
                  <input
                    id="child-agent-limit"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={ceiling}
                    step={1}
                    value={shownValue}
                    onChange={(event) => setDraft(event.target.value)}
                    style={{ ...inputStyle, width: '120px' }}
                  />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!isValidLimit || !(isLimitChanged || isScopeChanged) || saveMutation.isPending}
                  onClick={() => saveMutation.mutate({
                    ...(isLimitChanged ? { limit: parsedLimit } : {}),
                    ...(isScopeChanged ? { scope: shownScope } : {}),
                  })}
                >
                  {intl.formatMessage({ id: 'agents.allowance.save' })}
                </Button>
              </div>

              {showScopeFields && (
                <>
                  <ChildGrantScopeFields
                    idPrefix="child-allowance"
                    value={shownScope}
                    onChange={setScopeDraft}
                    disabled={saveMutation.isPending}
                    describedBy={isLimitAboveZero ? SCOPE_NOTE_ID : `${SCOPE_NOTE_ID} ${SCOPE_INACTIVE_ID}`}
                  />
                  {!isLimitAboveZero && (
                    <div id={SCOPE_INACTIVE_ID} style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                      {intl.formatMessage({ id: 'agents.allowance.grantScopeInactive' })}
                    </div>
                  )}
                  <div id={SCOPE_NOTE_ID} style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                    {intl.formatMessage({ id: 'agents.allowance.grantScopeNote' })}
                  </div>
                </>
              )}

              {!isValidLimit && (
                <div style={{ fontSize: '0.8125rem', color: 'var(--color-danger)' }}>
                  {intl.formatMessage({ id: 'agents.allowance.invalid' }, { ceiling })}
                </div>
              )}
              {isBelowChildCount && (
                <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                  {intl.formatMessage({ id: 'agents.allowance.keepChildren' })}
                </div>
              )}
            </>
          )}
        </div>
      </details>
    </Card>
  );
}

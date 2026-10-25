import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, type Agent } from '../../lib/api-client.js';
import { Card, Button, ErrorBanner, FieldLabel, LoadingRows, SectionLabel, inputStyle } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

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

  const allowanceQuery = useQuery({
    queryKey: ['agents', agent.id, 'child-allowance'],
    queryFn: () => agentsApi.childAllowance(agent.id),
    enabled: ceiling > 0,
  });

  const saveMutation = useMutation({
    mutationFn: (childAgentLimit: number) => agentsApi.setChildLimit(agent.id, childAgentLimit),
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['agents', agent.id, 'child-allowance'] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  if (ceiling <= 0) return null;

  const allowance = allowanceQuery.data;
  const shownValue = draft ?? String(allowance?.childAgentLimit ?? 0);
  const parsedLimit = Number(shownValue);
  const isValidLimit = shownValue.trim() !== '' && Number.isInteger(parsedLimit) && parsedLimit >= 0 && parsedLimit <= ceiling;
  const isBelowChildCount = isValidLimit && allowance !== undefined && parsedLimit < allowance.childCount;
  const isUnchanged = allowance !== undefined && isValidLimit && parsedLimit === allowance.childAgentLimit;

  return (
    <Card>
      <SectionLabel prominent>{intl.formatMessage({ id: 'agents.allowance.title' })}</SectionLabel>
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
                disabled={!isValidLimit || isUnchanged || saveMutation.isPending}
                onClick={() => saveMutation.mutate(parsedLimit)}
              >
                {intl.formatMessage({ id: 'agents.allowance.save' })}
              </Button>
            </div>

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
    </Card>
  );
}

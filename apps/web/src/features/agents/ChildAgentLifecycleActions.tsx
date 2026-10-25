import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, type Agent } from '../../lib/api-client.js';
import { Button, ErrorBanner } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { canPauseAgent, canStopAgent } from './agent-display.js';

// Same reason the agent card sends for a user pause.
const USER_PAUSE_REASON = 'User paused from dashboard';

export function pauseChildAgent(agentId: string) {
  return agentsApi.pause(agentId, USER_PAUSE_REASON);
}

export function stopChildAgent(agentId: string) {
  return agentsApi.stop(agentId);
}

interface ChildAgentLifecycleControlsProps {
  showPause: boolean;
  showStop: boolean;
  pending: boolean;
  errorMessage: string | null;
  onPause: () => void;
  onStop: () => void;
}

export function ChildAgentLifecycleControls({ showPause, showStop, pending, errorMessage, onPause, onStop }: ChildAgentLifecycleControlsProps) {
  const intl = useIntl();

  if (!showPause && !showStop) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {errorMessage && <ErrorBanner message={errorMessage} />}
      <div style={{ display: 'flex', gap: '8px' }}>
        {showPause && (
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={onPause}>
            {intl.formatMessage({ id: 'agents.tree.pause' })}
          </Button>
        )}
        {showStop && (
          <Button type="button" variant="danger" size="sm" disabled={pending} onClick={onStop}>
            {intl.formatMessage({ id: 'agents.tree.stop' })}
          </Button>
        )}
      </div>
    </div>
  );
}

interface ChildAgentLifecycleActionsProps {
  agent: Agent;
}

export function ChildAgentLifecycleActions({ agent }: ChildAgentLifecycleActionsProps) {
  const intl = useIntl();
  const qc = useQueryClient();

  const invalidateAgent = () => {
    void qc.invalidateQueries({ queryKey: ['agents', agent.id] });
    void qc.invalidateQueries({ queryKey: ['agents'] });
  };

  const pauseMutation = useMutation({
    mutationFn: () => pauseChildAgent(agent.id),
    onSuccess: invalidateAgent,
  });

  const stopMutation = useMutation({
    mutationFn: () => stopChildAgent(agent.id),
    onSuccess: invalidateAgent,
  });

  const failure = pauseMutation.isError ? pauseMutation.error : stopMutation.isError ? stopMutation.error : null;

  return (
    <ChildAgentLifecycleControls
      showPause={canPauseAgent(agent.status)}
      showStop={canStopAgent(agent.status)}
      pending={pauseMutation.isPending || stopMutation.isPending}
      errorMessage={failure ? localizeApiError(intl, failure, 'common.errorTitle') : null}
      onPause={() => pauseMutation.mutate()}
      onStop={() => stopMutation.mutate()}
    />
  );
}

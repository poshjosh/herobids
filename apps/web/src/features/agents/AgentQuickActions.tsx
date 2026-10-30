import type { CSSProperties, MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi } from '../../lib/api-client.js';
import { canPauseAgent, canStopAgent } from './agent-display.js';

const ICON_BUTTON_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '32px',
  height: '32px',
  borderRadius: '6px',
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface-1)',
  color: 'var(--color-text-secondary)',
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'background 0.15s, color 0.15s',
};

interface AgentQuickActionsProps {
  agentId: string;
  status: string;
}

/** Edit, start or resume, pause, and stop buttons for one agent. Used on agent rows and above the agent chat. */
export function AgentQuickActions({ agentId, status }: AgentQuickActionsProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const invalidateAgent = () => {
    void qc.invalidateQueries({ queryKey: ['agents', agentId] });
    void qc.invalidateQueries({ queryKey: ['agents'] });
  };

  const startMutation = useMutation({
    mutationFn: () => agentsApi.start(agentId),
    onSuccess: invalidateAgent,
  });

  const pauseMutation = useMutation({
    mutationFn: () => agentsApi.pause(agentId, 'User paused from dashboard'),
    onSuccess: invalidateAgent,
  });

  const resumeMutation = useMutation({
    mutationFn: () => agentsApi.resume(agentId),
    onSuccess: invalidateAgent,
  });

  const stopMutation = useMutation({
    mutationFn: () => agentsApi.stop(agentId),
    onSuccess: invalidateAgent,
  });

  const canStart = status === 'stopped' || status === 'crashed';
  const canPause = canPauseAgent(status);
  const canResume = status === 'paused';
  const canStop = canStopAgent(status);
  const anyActionPending = startMutation.isPending || pauseMutation.isPending || resumeMutation.isPending || stopMutation.isPending;

  // Stops the click from reaching a parent that opens the agent.
  const handleAction = (e: MouseEvent, fn: () => void) => {
    e.stopPropagation();
    fn();
  };

  return (
    <>
      <button
        type="button"
        style={ICON_BUTTON_STYLE}
        title="Edit"
        disabled={anyActionPending}
        onClick={(e) => handleAction(e, () => navigate(`/agents/${agentId}/details?edit=1`))}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      </button>

      {(canStart || canResume) && (
        <button
          type="button"
          style={{ ...ICON_BUTTON_STYLE, color: 'var(--color-success)', borderColor: 'var(--color-success)' }}
          title="Start"
          disabled={anyActionPending}
          onClick={(e) => handleAction(e, () => (canStart ? startMutation : resumeMutation).mutate())}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </button>
      )}

      {canPause && (
        <button
          type="button"
          style={ICON_BUTTON_STYLE}
          title="Pause"
          disabled={anyActionPending}
          onClick={(e) => handleAction(e, () => pauseMutation.mutate())}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        </button>
      )}

      {canStop && (
        <button
          type="button"
          style={{ ...ICON_BUTTON_STYLE, color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}
          title="Stop"
          disabled={anyActionPending}
          onClick={(e) => handleAction(e, () => stopMutation.mutate())}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
        </button>
      )}
    </>
  );
}

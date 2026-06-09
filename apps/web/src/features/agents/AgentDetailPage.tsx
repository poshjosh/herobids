import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, agents as agentsApi, skills as skillsApi, type AgentOutboundMessage, type AgentArtifact, type CapabilityReadiness } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, ErrorBanner, Button, StatusBadge, RelativeTime, KV, SectionLabel } from '../../lib/ui.js';
import { EditAgentModal } from './EditAgentModal.js';
import { useEventStream, type UserEvent } from '../../lib/useEventStream.js';
import { extractAgentObjective, extractAgentOperatorContext, formatCapabilityFamily, formatCapabilityState, formatExecutionMode, hasCapabilityFamily, resolveSelectedSkills } from './agent-display.js';

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);

  const handleEvent = useCallback((event: UserEvent) => {
    if (event.type === 'agent.status' && event.agentId === id) {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'capability-readiness', 'trading'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'prompt'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'activity'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'messages'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'artifacts'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'sessions'] });
    } else if ((event.type === 'decision.accepted' || event.type === 'decision.rejected') && event.agentId === id) {
      void qc.invalidateQueries({ queryKey: ['agents', id, 'activity'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'messages'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'artifacts'] });
    }
  }, [id, qc]);
  useEventStream(handleEvent);

  const query = useQuery({
    queryKey: ['agents', id],
    queryFn: () => agentsApi.get(id!),
    enabled: !!id,
    refetchInterval: 30_000,
  });

  const shouldPollRuntimePanels = Boolean(query.data?.activeSession)
    || ['active', 'starting', 'paused', 'unhealthy'].includes(query.data?.status ?? '');

  const agent = query.data;

  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list(),
  });

  const selectedSkills = resolveSelectedSkills(agent?.skillIds ?? [], skillsQuery.data?.skills ?? []);

  const hasTradingCapability = hasCapabilityFamily(selectedSkills, 'trading');

  const capabilityQuery = useQuery({
    queryKey: ['agents', id, 'capability-readiness', 'trading'],
    queryFn: async () => agentsApi.capabilityReadiness(id!, 'trading') as Promise<CapabilityReadiness>,
    enabled: !!id && hasTradingCapability,
  });
  const tradingCapability = capabilityQuery.data;

  const startMutation = useMutation({
    mutationFn: () => agentsApi.start(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: () => agentsApi.pause(id!, 'User paused from UI'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: () => agentsApi.resume(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => agentsApi.stop(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => agentsApi.delete(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      navigate('/agents');
    },
  });

  const activityQuery = useQuery({
    queryKey: ['agents', id, 'activity'],
    queryFn: () => agentsApi.activity(id!, 20),
    enabled: !!id,
    refetchInterval: shouldPollRuntimePanels ? 15_000 : false,
  });

  const promptQuery = useQuery({
    queryKey: ['agents', id, 'prompt'],
    queryFn: async () => {
      try {
        return await agentsApi.prompt(id!);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'prompt_not_available') {
          return null;
        }

        throw error;
      }
    },
    enabled: !!id,
    refetchInterval: shouldPollRuntimePanels ? 15_000 : false,
  });

  const messagesQuery = useQuery({
    queryKey: ['agents', id, 'messages'],
    queryFn: () => agentsApi.messages(id!, 20),
    enabled: !!id,
    refetchInterval: shouldPollRuntimePanels ? 15_000 : false,
  });

  const artifactsQuery = useQuery({
    queryKey: ['agents', id, 'artifacts'],
    queryFn: () => agentsApi.artifacts(id!, 10),
    enabled: !!id,
    refetchInterval: shouldPollRuntimePanels ? 15_000 : false,
  });

  const sessionsQuery = useQuery({
    queryKey: ['agents', id, 'sessions'],
    queryFn: () => agentsApi.sessions(id!),
    enabled: !!id,
    refetchInterval: shouldPollRuntimePanels ? 15_000 : false,
  });

  const decisionsQuery = useQuery({
    queryKey: ['agents', id, 'decisions'],
    queryFn: () => agentsApi.decisions(id!, 20),
    enabled: !!id,
    refetchInterval: shouldPollRuntimePanels ? 15_000 : false,
  });

  if (query.isLoading) return <PageShell><LoadingRows count={5} /></PageShell>;
  if (query.isError) return <PageShell><ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} /></PageShell>;

  if (!agent) return <PageShell><ErrorState message="Agent not found" /></PageShell>;

  const objective = extractAgentObjective(agent.prompt);
  const operatorContext = extractAgentOperatorContext(agent.prompt);
  const lifecycleError = startMutation.error ?? pauseMutation.error ?? resumeMutation.error ?? stopMutation.error ?? deleteMutation.error;
  const canStop = ['active', 'starting', 'paused', 'unhealthy'].includes(agent.status);
  const runtimeAlert = agent.status === 'crashed'
    ? 'Agent crashed. The runtime stopped unexpectedly. Review recent activity and capability readiness below.'
    : (agent.activeSession?.status === 'unhealthy' && agent.status !== 'stopped')
      ? 'Agent runtime is unhealthy. Heartbeats are missing and the worker is recovering.'
      : null;

  return (
    <PageShell>
      <PageHeader
        title={agent.name}
        subtitle={objective}
        action={
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {(agent.status === 'stopped' || agent.status === 'crashed') && (
              <Button variant="secondary" onClick={() => setIsEditing(true)}>
                Edit config
              </Button>
            )}
            {agent.status === 'stopped' && (
              <Button variant="primary" onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
                {startMutation.isPending ? 'Starting...' : 'Start'}
              </Button>
            )}
            {agent.status === 'active' && (
              <Button variant="secondary" onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending}>
                Pause
              </Button>
            )}
            {agent.status === 'paused' && (
              <Button variant="primary" onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending}>
                Resume
              </Button>
            )}
            {canStop && (
              <Button variant="danger" onClick={() => stopMutation.mutate()} disabled={stopMutation.isPending}>
                {stopMutation.isPending ? 'Stopping...' : 'Stop'}
              </Button>
            )}
            {(agent.status === 'stopped' || agent.status === 'crashed') && (
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm('Delete this agent? This cannot be undone. Any running session will be stopped.')) {
                    deleteMutation.mutate();
                  }
                }}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </Button>
            )}
          </div>
        }
      />

      {isEditing && (
        <EditAgentModal
          agentId={id!}
          onClose={() => setIsEditing(false)}
          initialData={agent}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {runtimeAlert && <ErrorBanner message={runtimeAlert} />}
        {lifecycleError && <ErrorBanner message={(lifecycleError as Error).message} />}

        <Card>
          <SectionLabel>Agent status</SectionLabel>
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
            <KV label="Status" value={<StatusBadge status={agent.status} />} />
            <KV label="Execution mode" value={formatExecutionMode(agent.executionMode)} />
            <KV label="Created" value={<RelativeTime timestamp={agent.createdAt} />} />
            <KV label="Updated" value={<RelativeTime timestamp={agent.updatedAt} />} />
          </div>
        </Card>

        <Card>
          <SectionLabel>Objective</SectionLabel>
          <p style={{ margin: '0 0 12px', fontSize: '13px', lineHeight: '1.5' }}>{objective}</p>
          {operatorContext.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
              {operatorContext.map((item) => (
                <span
                  key={item}
                  style={{
                    padding: '3px 8px',
                    borderRadius: '20px',
                    background: 'var(--color-surface-2)',
                    fontSize: '12px',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {item}
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
            {agent.activeSession?.startedAt && (
              <KV label="Active since" value={<RelativeTime timestamp={agent.activeSession.startedAt} />} />
            )}
            {sessionsQuery.isSuccess && (
              <KV label="Sessions run" value={String((sessionsQuery.data as unknown[]).length)} />
            )}
          </div>
        </Card>

        <Card>
          <SectionLabel>System Prompt</SectionLabel>
          {promptQuery.isLoading && <LoadingRows count={1} />}
          {promptQuery.isError && (
            <ErrorState
              message={(promptQuery.error as Error).message}
              onRetry={() => void promptQuery.refetch()}
            />
          )}
          {promptQuery.isSuccess && promptQuery.data === null && (
            <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--color-text-muted)' }}>
              System prompt is available only while a recent runtime snapshot exists.
            </p>
          )}
          {promptQuery.isSuccess && promptQuery.data !== null && (
            <pre
              style={{
                margin: 0,
                padding: '12px 14px',
                background: 'var(--color-surface-2)',
                borderRadius: '8px',
                border: '1px solid var(--color-border)',
                fontSize: '12px',
                lineHeight: '1.5',
                color: 'var(--color-text-secondary)',
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflow: 'auto',
                maxHeight: '360px',
              }}
            >
              {promptQuery.data.prompt}
            </pre>
          )}
        </Card>

        <section aria-label="Capabilities">
          <Card>
            <SectionLabel>Capabilities</SectionLabel>
            {skillsQuery.isLoading && <LoadingRows count={2} />}
            {skillsQuery.isError && <ErrorState message={(skillsQuery.error as Error).message} />}
            {!skillsQuery.isLoading && !skillsQuery.isError && capabilityQuery.isLoading && <LoadingRows count={2} />}
            {capabilityQuery.isError && <ErrorState message={(capabilityQuery.error as Error).message} />}
            {!skillsQuery.isLoading && !skillsQuery.isError && !hasTradingCapability && (
              <div style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>No capability setup required.</div>
            )}
            {!skillsQuery.isLoading && !skillsQuery.isError && hasTradingCapability && tradingCapability && (
              <section
                aria-label="Trading capability readiness"
                style={{ padding: '14px 16px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface-1)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: '600' }}>{formatCapabilityFamily(tradingCapability.family)}</div>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{formatCapabilityState(tradingCapability.state)}</div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => navigate(`/agents/${agent.id}/capabilities/${tradingCapability.family}`)}
                  >
                    {tradingCapability.effectiveReady
                      ? `Open ${formatCapabilityFamily(tradingCapability.family).toLowerCase()} capability`
                      : `Configure ${formatCapabilityFamily(tradingCapability.family).toLowerCase()} capability`}
                  </Button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                  <div>Binding readiness: {formatCapabilityState(tradingCapability.bindingReadiness)}</div>
                  <div>Agent eligibility: {tradingCapability.agentEligibility}</div>
                  <div>Effective ready: {tradingCapability.effectiveReady ? 'Yes' : 'No'}</div>
                  <div>Binding: {tradingCapability.bindingId ?? 'Not assigned'}</div>
                  {tradingCapability.reasons.length > 0 && (
                    <div>Reasons: {tradingCapability.reasons.join('; ')}</div>
                  )}
                </div>
              </section>
            )}
          </Card>
        </section>

        {agent.activeSession && (
          <Card>
            <SectionLabel>Runtime health</SectionLabel>
            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
              <KV label="Session" value={agent.activeSession.id.slice(0, 8)} />
              <KV label="Status" value={<StatusBadge status={agent.activeSession.status} />} />
              <KV label="Last heartbeat" value={<RelativeTime timestamp={agent.activeSession.lastHeartbeatAt} />} />
            </div>
          </Card>
        )}

        <Card>
          <SectionLabel>Messages to user</SectionLabel>
          {messagesQuery.isLoading && <LoadingRows count={3} />}
          {messagesQuery.isSuccess && messagesQuery.data.length === 0 && (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>No messages sent yet.</p>
          )}
          {messagesQuery.isSuccess && messagesQuery.data.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {messagesQuery.data.map((msg: AgentOutboundMessage) => (
                <div key={msg.id} style={{ padding: '10px 12px', borderRadius: '6px', background: 'var(--color-surface-raised)', fontSize: '13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: msg.subject ? '4px' : '0' }}>
                    <span style={{ fontWeight: '500', color: msg.authoredBy === 'platform' ? 'var(--color-warning)' : 'var(--color-text)' }}>
                      {msg.authoredBy === 'platform' ? '🔔 Safety Alert' : '💬 Agent'}
                    </span>
                    <span style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <StatusBadge status={msg.deliveryStatus} />
                      <RelativeTime timestamp={msg.createdAt} />
                    </span>
                  </div>
                  {msg.subject && <div style={{ fontWeight: '600', marginBottom: '2px' }}>{msg.subject}</div>}
                  <div style={{ color: 'var(--color-text-muted)' }}>{msg.body}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <SectionLabel>Recent Decisions</SectionLabel>
          {decisionsQuery.isLoading && <LoadingRows count={3} />}
          {decisionsQuery.isSuccess && (decisionsQuery.data as unknown[]).length === 0 && (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>No decisions submitted yet.</p>
          )}
          {decisionsQuery.isSuccess && (decisionsQuery.data as unknown[]).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
              {(decisionsQuery.data as Array<{ id: string; intent: string; createdAt: string }>).map((d) => (
                <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <span>{d.intent}</span>
                  <RelativeTime timestamp={d.createdAt} />
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <SectionLabel>Protocol activity</SectionLabel>
          {activityQuery.isLoading && <LoadingRows count={3} />}
          {activityQuery.isSuccess && (activityQuery.data as unknown[]).length === 0 && (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>No protocol messages yet.</p>
          )}
          {activityQuery.isSuccess && (activityQuery.data as unknown[]).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
              {(activityQuery.data as Array<{ id: string; type: string; createdAt: string }>).map((msg) => (
                <div key={msg.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <span>{msg.type}</span>
                  <RelativeTime timestamp={msg.createdAt} />
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <SectionLabel>Artifacts</SectionLabel>
          {artifactsQuery.isLoading && <LoadingRows count={3} />}
          {artifactsQuery.isSuccess && artifactsQuery.data.length === 0 && (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>No artifacts published yet.</p>
          )}
          {artifactsQuery.isSuccess && artifactsQuery.data.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              {artifactsQuery.data.map((a: AgentArtifact) => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <span>
                    <span style={{ fontWeight: '500' }}>{a.artifactType}</span>
                    {' · '}
                    <span style={{ color: 'var(--color-text-muted)' }}>{a.contentType}</span>
                    {a.summary && <span style={{ marginLeft: '8px', color: 'var(--color-text-muted)' }}>{a.summary}</span>}
                  </span>
                  <RelativeTime timestamp={a.createdAt} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </PageShell>
  );
}
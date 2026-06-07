import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, LoadingRows, ErrorState, EmptyState, Button, Modal, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { AGENT_SKILL_PRESETS, type AgentSkillPreset, formatExecutionMode, formatCapabilityFamily } from './agent-display.js';
import { AgentSummaryCard } from './AgentSummaryCard.js';

const RISK_TOLERANCES = [
  { value: 'conservative', label: 'Conservative', description: 'Smaller positions, lower drawdown tolerance' },
  { value: 'moderate', label: 'Moderate', description: 'Balanced risk-reward' },
  { value: 'aggressive', label: 'Aggressive', description: 'Larger positions, higher potential returns and losses' },
] as const;

type RiskToleranceValue = typeof RISK_TOLERANCES[number]['value'];
type SkillPresetValue = AgentSkillPreset['value'];
type CreateStep = 'intent' | 'review';

interface IntentState {
  goal: string;
  skillPreset: SkillPresetValue;
  executionMode: 'paper' | 'shadow' | 'live';
  providerHint: string;
  riskTolerance: RiskToleranceValue;
}

export function AgentsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();

  useEffect(() => {
    const createRequested = new URLSearchParams(location.search).get('create') === '1';
    if (createRequested) {
      setShowCreate(true);
    }
  }, [location.search]);

  const query = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });

  const items = query.data ?? [];

  const openCreate = () => {
    setShowCreate(true);
    navigate('/agents?create=1', { replace: true });
  };

  const closeCreate = () => {
    setShowCreate(false);
    navigate('/agents', { replace: true });
  };

  return (
    <PageShell>
      <PageHeader
        title="Agents"
        subtitle="Goal-driven agents with explicit skills and execution modes"
        action={<Button variant="primary" onClick={openCreate}>New agent</Button>}
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No agents yet"
          message="Describe the goal, then add capabilities only when you need them."
          action={<Button variant="primary" onClick={openCreate}>Create agent</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {items.map((agent) => (
            <AgentSummaryCard key={agent.id} agent={agent} onOpen={() => navigate(`/agents/${agent.id}`)} />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateAgentFlow
          onClose={closeCreate}
          onCreated={(id) => {
            setShowCreate(false);
            void qc.invalidateQueries({ queryKey: ['agents'] });
            navigate(`/agents/${id}`);
          }}
        />
      )}
    </PageShell>
  );
}

function CreateAgentFlow({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [step, setStep] = useState<CreateStep>('intent');
  const [intent, setIntent] = useState<IntentState>({
    goal: '',
    skillPreset: 'general',
    executionMode: 'paper',
    providerHint: '',
    riskTolerance: 'moderate',
  });

  const selectedPreset = AGENT_SKILL_PRESETS.find((preset) => preset.value === intent.skillPreset) ?? AGENT_SKILL_PRESETS[0]!;
  const requiresTradingSetup = selectedPreset.capabilityFamilies.includes('trading');

  const mutation = useMutation({
    mutationFn: () => {
      const name = intent.goal.length > 60 ? `${intent.goal.slice(0, 57)}…` : intent.goal;
      return agentsApi.create({
        name,
        prompt: buildPrompt(intent, selectedPreset),
        skillIds: [...selectedPreset.skillIds],
        executionMode: intent.executionMode,
      });
    },
    onSuccess: (agent) => onCreated(agent.id),
  });

  if (step === 'intent') {
    return (
      <Modal title="Create agent" onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <FieldLabel>What should the agent do?</FieldLabel>
            <textarea
              style={{ ...inputStyle, minHeight: '72px', resize: 'vertical' }}
              value={intent.goal}
              onChange={(e) => setIntent((state) => ({ ...state, goal: e.target.value }))}
              placeholder="e.g. Grow my Solana portfolio conservatively over 30 days"
              required
            />
          </div>

          <div>
            <FieldLabel>Agent type</FieldLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {AGENT_SKILL_PRESETS.map((preset) => (
                <label
                  key={preset.value}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '10px',
                    padding: '10px 12px',
                    border: `1px solid ${intent.skillPreset === preset.value ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    borderRadius: '6px',
                    cursor: 'pointer',
                    background: intent.skillPreset === preset.value ? 'var(--color-accent-subtle, rgba(99,102,241,0.08))' : 'transparent',
                  }}
                >
                  <input
                    type="radio"
                    name="skillPreset"
                    value={preset.value}
                    checked={intent.skillPreset === preset.value}
                    onChange={() => setIntent((state) => ({ ...state, skillPreset: preset.value }))}
                    style={{ marginTop: '2px', flexShrink: 0 }}
                  />
                  <div>
                    <div style={{ fontWeight: '500', fontSize: '14px' }}>{preset.label}</div>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' }}>{preset.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div>
            <FieldLabel>Execution mode</FieldLabel>
            <select
              value={intent.executionMode}
              onChange={(e) => setIntent((state) => ({ ...state, executionMode: e.target.value as IntentState['executionMode'] }))}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="paper">Paper — simulated, no real money</option>
              <option value="shadow">Shadow — tracks prices, no orders</option>
              <option value="live">Live — real order placement</option>
            </select>
          </div>

          {requiresTradingSetup && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface-1)' }}>
              <div>
                <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '4px' }}>{formatCapabilityFamily('trading')} setup</div>
                <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                  Keep the agent creation flow light. You can finish trading setup from the agent page after creation.
                </div>
              </div>

              <div>
                <FieldLabel>Provider hint (optional)</FieldLabel>
                <input
                  style={inputStyle}
                  value={intent.providerHint}
                  onChange={(e) => setIntent((state) => ({ ...state, providerHint: e.target.value }))}
                  placeholder="e.g. hyperliquid, jupiter, zapier"
                />
              </div>

              <div>
                <FieldLabel>Risk tolerance</FieldLabel>
                <select
                  value={intent.riskTolerance}
                  onChange={(e) => setIntent((state) => ({ ...state, riskTolerance: e.target.value as RiskToleranceValue }))}
                  style={{ ...inputStyle, cursor: 'pointer' }}
                >
                  {RISK_TOLERANCES.map((risk) => (
                    <option key={risk.value} value={risk.value}>
                      {risk.label} — {risk.description}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
            <Button variant="primary" type="button" disabled={!intent.goal.trim()} onClick={() => setStep('review')}>
              Review →
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Review and create" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ padding: '12px', background: 'var(--color-bg-subtle, rgba(0,0,0,0.04))', borderRadius: '6px', fontSize: '14px', lineHeight: '1.5' }}>
          {intent.goal}
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <tbody>
            <ReviewRow label="Agent type" value={selectedPreset.label} />
            <ReviewRow label="Execution mode" value={formatExecutionMode(intent.executionMode)} />
            <ReviewRow label="Skills" value={selectedPreset.skillIds.length > 0 ? selectedPreset.skillIds.join(', ') : 'Base only'} />
            <ReviewRow label="Capability setup" value={requiresTradingSetup ? 'Trading setup can be completed after creation' : 'No capability-specific setup required'} />
            {requiresTradingSetup && intent.providerHint.trim() && (
              <ReviewRow label="Provider hint" value={intent.providerHint.trim()} />
            )}
          </tbody>
        </table>

        {mutation.isError && <ErrorBanner message={(mutation.error as Error).message} />}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'space-between' }}>
          <Button variant="ghost" onClick={() => setStep('intent')} type="button">← Back</Button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
            <Button variant="primary" type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending ? 'Creating…' : 'Create agent'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td style={{ padding: '6px 0', color: 'var(--color-text-muted)', whiteSpace: 'nowrap', paddingRight: '16px' }}>{label}</td>
      <td style={{ padding: '6px 0', fontWeight: '500' }}>{value}</td>
    </tr>
  );
}

function buildPrompt(intent: IntentState, preset: AgentSkillPreset): string {
  const goal = intent.goal.trim();
  const operatorContext: string[] = [];

  if (preset.capabilityFamilies.includes('trading')) {
    operatorContext.push(`Trading capability selected${intent.providerHint.trim() ? ` with provider hint ${intent.providerHint.trim()}` : ''}.`);
    operatorContext.push(`Risk tolerance: ${intent.riskTolerance}.`);
  }

  if (operatorContext.length === 0) {
    return goal;
  }

  return `${goal}\n\nOperator context:\n${operatorContext.map((line) => `- ${line}`).join('\n')}`;
}

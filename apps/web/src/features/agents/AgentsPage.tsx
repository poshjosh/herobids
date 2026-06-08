import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi, capabilities as capabilitiesApi, skills as skillsApi, type Skill, type TradingBindingSummary } from '../../lib/api-client.js';
import { PageShell, PageHeader, LoadingRows, ErrorState, EmptyState, Button, Modal, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { formatExecutionMode, formatCapabilityFamily, formatSkillSelection, hasCapabilityFamily, listSelectableSkills } from './agent-display.js';
import { AgentSummaryCard } from './AgentSummaryCard.js';
import { SkillPicker } from './SkillPicker.js';

const RISK_TOLERANCES = [
  { value: 'conservative', label: 'Conservative', description: 'Smaller positions, lower drawdown tolerance' },
  { value: 'moderate', label: 'Moderate', description: 'Balanced risk-reward' },
  { value: 'aggressive', label: 'Aggressive', description: 'Larger positions, higher potential returns and losses' },
] as const;

type RiskToleranceValue = typeof RISK_TOLERANCES[number]['value'];
type CreateStep = 'intent' | 'review';

interface IntentState {
  goal: string;
  skillIds: string[];
  executionMode: 'paper' | 'shadow' | 'live';
  tradingBindingId: string;
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

  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list(),
  });

  const items = query.data ?? [];
  const selectableSkills = listSelectableSkills(skillsQuery.data?.skills ?? []);

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
          skills={selectableSkills}
          skillsLoading={skillsQuery.isLoading}
          skillsError={skillsQuery.error instanceof Error ? skillsQuery.error.message : null}
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

function CreateAgentFlow({
  skills,
  skillsLoading,
  skillsError,
  onClose,
  onCreated,
}: {
  skills: Skill[];
  skillsLoading: boolean;
  skillsError: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [step, setStep] = useState<CreateStep>('intent');
  const [intent, setIntent] = useState<IntentState>({
    goal: '',
    skillIds: [],
    executionMode: 'paper',
    tradingBindingId: '',
    riskTolerance: 'moderate',
  });

  const selectedSkills = skills.filter((skill) => intent.skillIds.includes(skill.id));
  const requiresTradingSetup = hasCapabilityFamily(selectedSkills, 'trading');
  const tradingBindingsQuery = useQuery({
    queryKey: ['capabilities', 'trading', 'bindings'],
    queryFn: () => capabilitiesApi.tradingBindings(),
  });
  const availableTradingBindings = (tradingBindingsQuery.data?.bindings ?? []).filter(
    (binding) => binding.status === 'active' && binding.connectionStatus === 'active',
  );
  const selectedTradingBinding = availableTradingBindings.find((binding) => binding.bindingId === intent.tradingBindingId) ?? null;

  const mutation = useMutation({
    mutationFn: async () => {
      const name = intent.goal.length > 60 ? `${intent.goal.slice(0, 57)}…` : intent.goal;
      const agent = await agentsApi.create({
        name,
        prompt: buildPrompt(intent, selectedSkills, selectedTradingBinding),
        skillIds: [...intent.skillIds],
        executionMode: intent.executionMode,
      });

      if (requiresTradingSetup && intent.tradingBindingId) {
        await agentsApi.tradingAction(agent.id, 'bind', { bindingId: intent.tradingBindingId });
      }

      return agent;
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
            <FieldLabel>Skills</FieldLabel>
            <SkillPicker
              skills={skills}
              selectedSkillIds={intent.skillIds}
              onChange={(skillIds) => setIntent((state) => ({ ...state, skillIds }))}
              loading={skillsLoading}
              errorMessage={skillsError}
            />
            <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
              Base is included automatically. Select any additional skills the agent should have after creation.
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
                <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '4px' }}>{formatCapabilityFamily('trading')} capability setup</div>
                <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                  Select an existing trading binding to attach trading access as part of agent creation.
                </div>
              </div>

              <div>
                <FieldLabel>Trading binding</FieldLabel>
                {tradingBindingsQuery.isLoading ? (
                  <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>Loading trading bindings…</div>
                ) : availableTradingBindings.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                    No active trading bindings are available yet. Create a trading connection first, or create the agent now and bind it later.
                  </div>
                ) : (
                  <select
                    value={intent.tradingBindingId}
                    onChange={(e) => setIntent((state) => ({ ...state, tradingBindingId: e.target.value }))}
                    style={{ ...inputStyle, cursor: 'pointer' }}
                  >
                    <option value="">Choose an existing binding</option>
                    {availableTradingBindings.map((binding) => (
                      <option key={binding.bindingId} value={binding.bindingId}>
                        {binding.label} ({binding.provider})
                      </option>
                    ))}
                  </select>
                )}
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
            <ReviewRow label="Execution mode" value={formatExecutionMode(intent.executionMode)} />
            <ReviewRow label="Skills" value={formatSkillSelection(selectedSkills)} />
            <ReviewRow label="Capability setup" value={requiresTradingSetup ? (selectedTradingBinding ? 'Selected trading binding will be bound on create' : 'No binding selected; bind later from the capability page') : 'No capability-specific setup required'} />
            {requiresTradingSetup && selectedTradingBinding && (
              <ReviewRow label="Trading binding" value={`${selectedTradingBinding.label} (${selectedTradingBinding.provider})`} />
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

function buildPrompt(intent: IntentState, selectedSkills: Skill[], selectedTradingBinding: TradingBindingSummary | null): string {
  const goal = intent.goal.trim();
  const operatorContext: string[] = [];

  if (selectedSkills.length > 0) {
    operatorContext.push(`Selected skills: ${formatSkillSelection(selectedSkills)}.`);
  }

  if (hasCapabilityFamily(selectedSkills, 'trading')) {
    operatorContext.push('Trading capability selected.');
    if (selectedTradingBinding) {
      operatorContext.push(`Selected trading binding: ${selectedTradingBinding.label} (${selectedTradingBinding.provider}).`);
    }
    operatorContext.push(`Risk tolerance: ${intent.riskTolerance}.`);
  }

  if (operatorContext.length === 0) {
    return goal;
  }

  return `${goal}\n\nOperator context:\n${operatorContext.map((line) => `- ${line}`).join('\n')}`;
}

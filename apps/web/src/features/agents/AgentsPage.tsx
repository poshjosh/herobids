import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi, venueAccounts as venueAccountsApi } from '../../lib/api-client.js';
import type { VenueAccount } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button, StatusBadge, RelativeTime, KV, Modal, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';

// ---------------------------------------------------------------------------
// Skill presets — plain-language labels per plan 003
// ---------------------------------------------------------------------------
const SKILL_PRESETS = [
  {
    value: 'trading',
    label: 'Trading Agent',
    description: 'Trades on your behalf within your constraints',
    skillIds: ['bot-management'],
  },
  {
    value: 'reminder',
    label: 'Reminder Agent',
    description: 'Sends you scheduled updates and alerts',
    skillIds: [],
  },
] as const;

type SkillPresetValue = typeof SKILL_PRESETS[number]['value'];

// Risk tolerance options for intent step
const RISK_TOLERANCES = [
  { value: 'conservative', label: 'Conservative', description: 'Smaller positions, lower drawdown tolerance' },
  { value: 'moderate', label: 'Moderate', description: 'Balanced risk-reward' },
  { value: 'aggressive', label: 'Aggressive', description: 'Larger positions, higher potential returns and losses' },
] as const;

export function AgentsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });

  const items = query.data ?? [];

  return (
    <PageShell>
      <PageHeader
        title="AI Agents"
        subtitle="Autonomous agents that trade and monitor on your behalf"
        action={<Button variant="primary" onClick={() => setShowCreate(true)}>New Agent</Button>}
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No agents yet"
          message="Describe what you want — the agent figures out the rest."
          action={<Button variant="primary" onClick={() => setShowCreate(true)}>Create Agent</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {items.map((agent) => (
            <Card key={agent.id}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
                <div
                  style={{ flex: 1, cursor: 'pointer' }}
                  onClick={() => navigate(`/agents/${agent.id}`)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                    <span style={{ fontWeight: '600', fontSize: '15px' }}>{agent.name}</span>
                    <StatusBadge status={agent.status} />
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--color-text-muted)', marginBottom: '8px' }}>
                    {agent.prompt}
                  </div>
                  <div style={{ display: 'flex', gap: '24px' }}>
                    <KV label="Created" value={<RelativeTime timestamp={agent.createdAt} />} />
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateAgentFlow
          onClose={() => setShowCreate(false)}
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

// ---------------------------------------------------------------------------
// Two-step goal-driven create flow
//   Step 1 (Intent): free-text goal + skill preset + venue account + risk tolerance
//   Step 2 (Review): confirm inferred settings before creating
// ---------------------------------------------------------------------------
type CreateStep = 'intent' | 'review';

interface IntentState {
  goal: string;
  skillPreset: SkillPresetValue;
  venueAccountId: string;
  riskTolerance: 'conservative' | 'moderate' | 'aggressive';
}

function CreateAgentFlow({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [step, setStep] = useState<CreateStep>('intent');
  const [intent, setIntent] = useState<IntentState>({
    goal: '',
    skillPreset: 'trading',
    venueAccountId: '',
    riskTolerance: 'moderate',
  });

  const venueAccountsQuery = useQuery({ queryKey: ['venue-accounts'], queryFn: () => venueAccountsApi.list() });
  const venueAccounts: VenueAccount[] = venueAccountsQuery.data?.venueAccounts ?? [];
  const selectedVA = venueAccounts.find((va) => va.id === intent.venueAccountId);
  const selectedPreset = SKILL_PRESETS.find((p) => p.value === intent.skillPreset)!;

  const mutation = useMutation({
    mutationFn: () => {
      const name = intent.goal.length > 60 ? intent.goal.slice(0, 57) + '…' : intent.goal;
      const prompt = buildPrompt(intent, selectedVA);
      return agentsApi.create({
        name,
        prompt,
        skillIds: selectedPreset.skillIds as unknown as string[],
      });
    },
    onSuccess: (agent) => onCreated(agent.id),
  });

  if (step === 'intent') {
    return (
      <Modal title="Create Agent" onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Goal input */}
          <div>
            <FieldLabel>What should the agent do?</FieldLabel>
            <textarea
              style={{ ...inputStyle, minHeight: '72px', resize: 'vertical' }}
              value={intent.goal}
              onChange={(e) => setIntent((s) => ({ ...s, goal: e.target.value }))}
              placeholder="e.g. Grow my Solana portfolio conservatively over 30 days"
              required
            />
          </div>

          {/* Skill preset */}
          <div>
            <FieldLabel>Agent type</FieldLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {SKILL_PRESETS.map((p) => (
                <label
                  key={p.value}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '10px',
                    padding: '10px 12px',
                    border: `1px solid ${intent.skillPreset === p.value ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    borderRadius: '6px',
                    cursor: 'pointer',
                    background: intent.skillPreset === p.value ? 'var(--color-accent-subtle, rgba(99,102,241,0.08))' : 'transparent',
                  }}
                >
                  <input
                    type="radio"
                    name="skillPreset"
                    value={p.value}
                    checked={intent.skillPreset === p.value}
                    onChange={() => setIntent((s) => ({ ...s, skillPreset: p.value }))}
                    style={{ marginTop: '2px', flexShrink: 0 }}
                  />
                  <div>
                    <div style={{ fontWeight: '500', fontSize: '14px' }}>{p.label}</div>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' }}>{p.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Venue account (optional — agent can ask if not provided) */}
          <div>
            <FieldLabel>Venue account (optional)</FieldLabel>
            <select
              value={intent.venueAccountId}
              onChange={(e) => setIntent((s) => ({ ...s, venueAccountId: e.target.value }))}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="">— Let the agent decide —</option>
              {venueAccounts.map((va) => (
                <option key={va.id} value={va.id}>{va.label} ({va.venue})</option>
              ))}
            </select>
          </div>

          {/* Risk tolerance */}
          <div>
            <FieldLabel>Risk tolerance</FieldLabel>
            <select
              value={intent.riskTolerance}
              onChange={(e) => setIntent((s) => ({ ...s, riskTolerance: e.target.value as IntentState['riskTolerance'] }))}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              {RISK_TOLERANCES.map((r) => (
                <option key={r.value} value={r.value}>{r.label} — {r.description}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
            <Button
              variant="primary"
              type="button"
              disabled={!intent.goal.trim()}
              onClick={() => setStep('review')}
            >
              Review →
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  // Review step
  return (
    <Modal title="Review & Create" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ padding: '12px', background: 'var(--color-bg-subtle, rgba(0,0,0,0.04))', borderRadius: '6px', fontSize: '14px', lineHeight: '1.5' }}>
          {intent.goal}
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <tbody>
            <ReviewRow label="Agent type" value={selectedPreset.label} />
            <ReviewRow label="Venue" value={selectedVA ? `${selectedVA.label} (${selectedVA.venue})` : 'Agent will choose'} />
            <ReviewRow label="Risk" value={RISK_TOLERANCES.find((r) => r.value === intent.riskTolerance)?.label ?? intent.riskTolerance} />
            <ReviewRow label="Execution mode" value="Paper (change in settings)" />
            <ReviewRow label="Skills" value={selectedPreset.skillIds.length > 0 ? selectedPreset.skillIds.join(', ') : 'Base only'} />
          </tbody>
        </table>

        {mutation.isError && <ErrorBanner message={(mutation.error as Error).message} />}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'space-between' }}>
          <Button variant="ghost" onClick={() => setStep('intent')} type="button">← Back</Button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
            <Button variant="primary" type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending ? 'Creating…' : 'Create Agent'}
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

function buildPrompt(intent: IntentState, venueAccount: VenueAccount | undefined): string {
  const venuePart = venueAccount
    ? `Use venue account "${venueAccount.label}" (${venueAccount.venue}).`
    : '';
  const riskPart = `Risk tolerance: ${intent.riskTolerance}.`;
  return [intent.goal, venuePart, riskPart].filter(Boolean).join(' ');
}


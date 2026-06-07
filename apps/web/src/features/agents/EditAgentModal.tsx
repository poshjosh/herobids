import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi, skills as skillsApi, type Agent, type Skill } from '../../lib/api-client.js';
import { Modal, Button, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { formatExecutionMode, formatSkillSelection, listSelectableSkills } from './agent-display.js';
import { SkillPicker } from './SkillPicker.js';

interface EditAgentModalProps {
  agentId: string;
  onClose: () => void;
  initialData: Agent;
}

interface FormState {
  name: string;
  prompt: string;
  skillIds: string[];
  executionMode: string;
  telegramChatId: string;
  dailyTokenBudget: string;
  dailyLossLimit: string;
  maxBots: string;
  maxSlippageBps: string;
}

export function EditAgentModal({ agentId, onClose, initialData }: EditAgentModalProps) {
  const qc = useQueryClient();
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list(),
  });
  const selectableSkills = listSelectableSkills(skillsQuery.data?.skills ?? []);
  const selectableSkillIds = new Set(selectableSkills.map((skill) => skill.id));
  const preservedSkillIds = (initialData.skillIds ?? []).filter((skillId) => !selectableSkillIds.has(skillId));

  const [form, setForm] = useState<FormState>({
    name: initialData.name,
    prompt: initialData.prompt,
    skillIds: initialData.skillIds ?? [],
    executionMode: initialData.executionMode ?? '',
    telegramChatId: initialData.telegramChatId ?? '',
    dailyTokenBudget: initialData.dailyTokenBudget != null ? String(initialData.dailyTokenBudget) : '',
    dailyLossLimit: initialData.dailyLossLimit ?? '',
    maxBots: initialData.maxBots != null ? String(initialData.maxBots) : '',
    maxSlippageBps: initialData.maxSlippageBps != null ? String(initialData.maxSlippageBps) : '',
  });

  const set = (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const mutation = useMutation({
    mutationFn: () => {
      const skillIds = Array.from(new Set([...preservedSkillIds, ...form.skillIds.filter((skillId) => selectableSkillIds.has(skillId))]));
      return agentsApi.update(agentId, {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        skillIds,
        executionMode: form.executionMode || null,
        telegramChatId: form.telegramChatId.trim() || null,
        dailyTokenBudget: form.dailyTokenBudget ? parseInt(form.dailyTokenBudget, 10) : null,
        dailyLossLimit: form.dailyLossLimit.trim() || null,
        maxBots: form.maxBots ? parseInt(form.maxBots, 10) : null,
        maxSlippageBps: form.maxSlippageBps ? parseInt(form.maxSlippageBps, 10) : null,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', agentId] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
      onClose();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  const fieldGap: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '14px' };
  const rowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' };

  return (
    <Modal title="Edit agent" onClose={onClose}>
      <div
        style={{
          maxHeight: 'min(560px, 70vh)',
          overflowY: 'auto',
          paddingRight: '4px',
          marginRight: '-4px',
        }}
      >
        <form id="edit-agent-form" onSubmit={handleSubmit}>
          <div style={fieldGap}>
            <FieldLabel>Name</FieldLabel>
            <input style={inputStyle} value={form.name} onChange={set('name')} required maxLength={100} />
          </div>

          <div style={fieldGap}>
            <FieldLabel>Objective / prompt</FieldLabel>
            <textarea
              style={{ ...inputStyle, minHeight: '80px', resize: 'vertical' }}
              value={form.prompt}
              onChange={set('prompt')}
              required
              maxLength={4000}
            />
          </div>

          <div style={fieldGap}>
            <FieldLabel>Skills</FieldLabel>
            <SkillPicker
              skills={selectableSkills}
              selectedSkillIds={form.skillIds}
              onChange={(skillIds) => setForm((prev) => ({ ...prev, skillIds }))}
              loading={skillsQuery.isLoading}
              errorMessage={skillsQuery.error instanceof Error ? skillsQuery.error.message : null}
            />
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
              Base is included automatically. Select the skills this agent should keep using.
              {preservedSkillIds.length > 0 && (
                <span> Existing hidden skills will be preserved unless you replace them.</span>
              )}
            </div>
          </div>

          <div style={fieldGap}>
            <FieldLabel>Execution mode</FieldLabel>
            <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.executionMode} onChange={set('executionMode')}>
              <option value="">Not set — inherit or decide later</option>
              <option value="paper">Paper — simulated, no real money</option>
              <option value="shadow">Shadow — tracks prices, no orders</option>
              <option value="live">Live — real order placement</option>
            </select>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{formatExecutionMode(form.executionMode)} is the runtime mode visible to operators.</div>
          </div>

          <div style={fieldGap}>
            <FieldLabel>Selected skills</FieldLabel>
            <div style={{ fontSize: '13px', color: 'var(--color-text-primary)', lineHeight: '1.5' }}>
              {formatSkillSelection(selectableSkills.filter((skill) => form.skillIds.includes(skill.id)))}
            </div>
          </div>

          <div style={fieldGap}>
            <FieldLabel>Telegram chat ID</FieldLabel>
            <input style={inputStyle} value={form.telegramChatId} onChange={set('telegramChatId')} placeholder="Optional" />
          </div>

          <div style={{ ...rowStyle, marginBottom: '14px' }}>
            <div style={fieldGap}>
              <FieldLabel>Daily token budget</FieldLabel>
              <input style={inputStyle} type="number" min={1} value={form.dailyTokenBudget} onChange={set('dailyTokenBudget')} placeholder="Unlimited" />
            </div>
            <div style={fieldGap}>
              <FieldLabel>Max bots</FieldLabel>
              <input style={inputStyle} type="number" min={1} value={form.maxBots} onChange={set('maxBots')} placeholder="Unlimited" />
            </div>
          </div>

          <div style={{ ...rowStyle, marginBottom: '0' }}>
            <div style={fieldGap}>
              <FieldLabel>Daily loss limit (USD)</FieldLabel>
              <input style={inputStyle} value={form.dailyLossLimit} onChange={set('dailyLossLimit')} placeholder="Unlimited" />
            </div>
            <div style={fieldGap}>
              <FieldLabel>Max slippage (bps)</FieldLabel>
              <input style={inputStyle} type="number" min={0} value={form.maxSlippageBps} onChange={set('maxSlippageBps')} placeholder="Default" />
            </div>
          </div>
        </form>
      </div>

      {mutation.isError && <ErrorBanner message={(mutation.error as Error).message} />}

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '20px' }}>
        <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
        <Button variant="primary" type="submit" form="edit-agent-form" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </Modal>
  );
}
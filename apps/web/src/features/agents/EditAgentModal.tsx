import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi, type Agent } from '../../lib/api-client.js';
import { Modal, Button, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';

const SKILL_PRESETS = [
  { value: 'trading', label: 'Trading Agent', skillIds: ['bot-management'] },
  { value: 'reminder', label: 'Reminder Agent', skillIds: [] },
] as const;

type SkillPresetValue = typeof SKILL_PRESETS[number]['value'];

function skillIdsToPreset(skillIds: string[]): SkillPresetValue {
  if (skillIds.includes('bot-management')) return 'trading';
  return 'reminder';
}

interface EditAgentModalProps {
  agentId: string;
  onClose: () => void;
  initialData: Agent;
}

interface FormState {
  name: string;
  prompt: string;
  skillPreset: SkillPresetValue;
  executionMode: string;
  telegramChatId: string;
  dailyTokenBudget: string;
  dailyLossLimit: string;
  maxBots: string;
  maxSlippageBps: string;
}

export function EditAgentModal({ agentId, onClose, initialData }: EditAgentModalProps) {
  const qc = useQueryClient();
  // Capture the preset at mount time so we can detect whether the user changed it.
  // If unchanged, we omit skillIds from the PATCH body to avoid silently dropping
  // any non-preset skills the agent may carry.
  const initialSkillPreset = skillIdsToPreset(initialData.skillIds ?? []);

  const [form, setForm] = useState<FormState>({
    name: initialData.name,
    prompt: initialData.prompt,
    skillPreset: skillIdsToPreset(initialData.skillIds ?? []),
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
      const preset = SKILL_PRESETS.find((p) => p.value === form.skillPreset)!;
      return agentsApi.update(agentId, {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        // Only overwrite skillIds when the user explicitly changed the preset type;
        // preserves any non-preset skills the agent may have.
        ...(form.skillPreset !== initialSkillPreset ? { skillIds: [...preset.skillIds] } : {}),
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
    <Modal title="Edit Agent Configuration" onClose={onClose}>
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
            <FieldLabel>Objective / Prompt</FieldLabel>
            <textarea
              style={{ ...inputStyle, minHeight: '80px', resize: 'vertical' }}
              value={form.prompt}
              onChange={set('prompt')}
              required
              maxLength={4000}
            />
          </div>

          <div style={fieldGap}>
            <FieldLabel>Agent type</FieldLabel>
            <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.skillPreset} onChange={set('skillPreset')}>
              {SKILL_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          <div style={fieldGap}>
            <FieldLabel>Execution mode</FieldLabel>
            <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.executionMode} onChange={set('executionMode')}>
              <option value="">— Not set —</option>
              <option value="paper">Paper — simulated, no real money</option>
              <option value="shadow">Shadow — tracks prices, no orders</option>
              <option value="live">Live — real order placement</option>
            </select>
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
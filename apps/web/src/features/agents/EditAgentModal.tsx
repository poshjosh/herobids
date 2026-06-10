import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, skills as skillsApi, ai as aiApi, type Agent } from '../../lib/api-client.js';
import { Modal, Button, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { formatExecutionMode, formatSkillSelection, listSelectableSkills } from './agent-display.js';
import { SkillPicker } from './SkillPicker.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { ModelSelectionFields } from '../settings/ModelSelectionFields.js';

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
  const intl = useIntl();
  const qc = useQueryClient();
  const hasExplicitModelOverride = Boolean(initialData.provider || initialData.lightModel || initialData.heavyModel);
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list(),
  });
  const availableModelsQuery = useQuery({
    queryKey: ['ai', 'available-models'],
    queryFn: () => aiApi.availableModels(),
  });
  const aiSettingsQuery = useQuery({
    queryKey: ['ai', 'settings'],
    queryFn: () => aiApi.settings(),
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
  const [modelOverrideEnabled, setModelOverrideEnabled] = useState(hasExplicitModelOverride);
  const [modelForm, setModelForm] = useState({
    provider: initialData.provider ?? '',
    lightModel: initialData.lightModel ?? '',
    heavyModel: initialData.heavyModel ?? '',
  });
  const inheritedModelSettings = aiSettingsQuery.data?.aiModelConfig ?? null;

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
        provider: modelOverrideEnabled ? modelForm.provider || null : null,
        lightModel: modelOverrideEnabled ? modelForm.lightModel || null : null,
        heavyModel: modelOverrideEnabled ? modelForm.heavyModel || null : null,
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
    <Modal title={intl.formatMessage({ id: 'agents.edit.title' })} onClose={onClose}>
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
            <FieldLabel>{intl.formatMessage({ id: 'agents.edit.name' })}</FieldLabel>
            <input style={inputStyle} value={form.name} onChange={set('name')} required maxLength={100} />
          </div>

          <div style={fieldGap}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.edit.objective' })}</FieldLabel>
            <textarea
              style={{ ...inputStyle, minHeight: '80px', resize: 'vertical' }}
              value={form.prompt}
              onChange={set('prompt')}
              required
              maxLength={4000}
            />
          </div>

          <div style={fieldGap}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.create.skills' })}</FieldLabel>
            <SkillPicker
              skills={selectableSkills}
              selectedSkillIds={form.skillIds}
              onChange={(skillIds) => setForm((prev) => ({ ...prev, skillIds }))}
              loading={skillsQuery.isLoading}
              errorMessage={skillsQuery.error instanceof Error ? skillsQuery.error.message : null}
            />
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
              {intl.formatMessage({ id: 'agents.edit.skillsHelp' })}
              {preservedSkillIds.length > 0 && (
                <span> {intl.formatMessage({ id: 'agents.edit.skillsHelpPreserved' })}</span>
              )}
            </div>
          </div>

          <div style={fieldGap}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.executionMode.label' })}</FieldLabel>
            <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.executionMode} onChange={set('executionMode')}>
              <option value="">{intl.formatMessage({ id: 'agents.edit.executionModeUnset' })}</option>
              <option value="paper">{intl.formatMessage({ id: 'agents.create.executionMode.paper' })}</option>
              <option value="shadow">{intl.formatMessage({ id: 'agents.create.executionMode.shadow' })}</option>
              <option value="live">{intl.formatMessage({ id: 'agents.create.executionMode.live' })}</option>
            </select>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
              {intl.formatMessage({ id: 'agents.edit.executionModeHelp' }, { mode: formatExecutionMode(form.executionMode, intl) })}
            </div>
          </div>

          <div style={fieldGap}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.edit.selectedSkills' })}</FieldLabel>
            <div style={{ fontSize: '13px', color: 'var(--color-text-primary)', lineHeight: '1.5' }}>
              {formatSkillSelection(selectableSkills.filter((skill) => form.skillIds.includes(skill.id)), intl)}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '14px', padding: '16px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface-1)' }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '4px' }}>
                {intl.formatMessage({ id: 'agents.edit.models.title' })}
              </div>
              <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                {modelOverrideEnabled
                  ? intl.formatMessage({ id: 'agents.edit.models.description' })
                  : intl.formatMessage({ id: 'agents.edit.models.inherited' }, {
                    provider: inheritedModelSettings?.provider ?? intl.formatMessage({ id: 'common.default' }),
                    lightModel: inheritedModelSettings?.lightModel ?? intl.formatMessage({ id: 'common.default' }),
                    heavyModel: inheritedModelSettings?.heavyModel ?? intl.formatMessage({ id: 'common.default' }),
                  })}
              </div>
            </div>

            {!modelOverrideEnabled ? (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: '13px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                  {intl.formatMessage({ id: 'agents.edit.models.inheritHelp' })}
                </div>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    setModelOverrideEnabled(true);
                    if (inheritedModelSettings) {
                      setModelForm({
                        provider: inheritedModelSettings.provider,
                        lightModel: inheritedModelSettings.lightModel,
                        heavyModel: inheritedModelSettings.heavyModel,
                      });
                    }
                  }}
                >
                  {intl.formatMessage({ id: 'agents.edit.models.override' })}
                </Button>
              </div>
            ) : (
              <>
                <ModelSelectionFields
                  value={modelForm}
                  providers={availableModelsQuery.data?.providers ?? []}
                  loading={availableModelsQuery.isLoading}
                  loadingLabel={intl.formatMessage({ id: 'aiModels.loading' })}
                  emptyLabel={intl.formatMessage({ id: 'aiModels.empty' })}
                  providerLabel={intl.formatMessage({ id: 'aiModels.provider.label' })}
                  providerPlaceholder={intl.formatMessage({ id: 'aiModels.provider.placeholder' })}
                  economyLabel={intl.formatMessage({ id: 'aiModels.economy.label' })}
                  economyHelp={intl.formatMessage({ id: 'aiModels.economy.help' })}
                  premiumLabel={intl.formatMessage({ id: 'aiModels.premium.label' })}
                  premiumHelp={intl.formatMessage({ id: 'aiModels.premium.help' })}
                  onChange={setModelForm}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                    {intl.formatMessage({ id: 'agents.edit.models.overrideHelp' })}
                  </div>
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => {
                      setModelOverrideEnabled(false);
                      setModelForm({ provider: '', lightModel: '', heavyModel: '' });
                    }}
                  >
                    {intl.formatMessage({ id: 'agents.edit.models.clearOverride' })}
                  </Button>
                </div>
              </>
            )}
          </div>

          <div style={fieldGap}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.edit.telegramChatId' })}</FieldLabel>
            <input style={inputStyle} value={form.telegramChatId} onChange={set('telegramChatId')} placeholder={intl.formatMessage({ id: 'common.optional' })} />
          </div>

          <div style={{ ...rowStyle, marginBottom: '14px' }}>
            <div style={fieldGap}>
              <FieldLabel>{intl.formatMessage({ id: 'agents.edit.dailyTokenBudget' })}</FieldLabel>
              <input style={inputStyle} type="number" min={1} value={form.dailyTokenBudget} onChange={set('dailyTokenBudget')} placeholder={intl.formatMessage({ id: 'common.unlimited' })} />
            </div>
            <div style={fieldGap}>
              <FieldLabel>{intl.formatMessage({ id: 'agents.edit.maxBots' })}</FieldLabel>
              <input style={inputStyle} type="number" min={1} value={form.maxBots} onChange={set('maxBots')} placeholder={intl.formatMessage({ id: 'common.unlimited' })} />
            </div>
          </div>

          <div style={{ ...rowStyle, marginBottom: '0' }}>
            <div style={fieldGap}>
              <FieldLabel>{intl.formatMessage({ id: 'agents.edit.dailyLossLimit' })}</FieldLabel>
              <input style={inputStyle} value={form.dailyLossLimit} onChange={set('dailyLossLimit')} placeholder={intl.formatMessage({ id: 'common.unlimited' })} />
            </div>
            <div style={fieldGap}>
              <FieldLabel>{intl.formatMessage({ id: 'agents.edit.maxSlippage' })}</FieldLabel>
              <input style={inputStyle} type="number" min={0} value={form.maxSlippageBps} onChange={set('maxSlippageBps')} placeholder={intl.formatMessage({ id: 'common.default' })} />
            </div>
          </div>
        </form>
      </div>

      {mutation.isError && <ErrorBanner message={localizeApiError(intl, mutation.error, 'common.errorTitle')} />}

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '20px' }}>
        <Button variant="ghost" onClick={onClose} type="button">{intl.formatMessage({ id: 'common.cancel' })}</Button>
        <Button
          variant="primary"
          type="submit"
          form="edit-agent-form"
          disabled={mutation.isPending || (modelOverrideEnabled && (!modelForm.provider || !modelForm.lightModel || !modelForm.heavyModel))}
        >
          {mutation.isPending ? intl.formatMessage({ id: 'agents.edit.saving' }) : intl.formatMessage({ id: 'common.saveChanges' })}
        </Button>
      </div>
    </Modal>
  );
}
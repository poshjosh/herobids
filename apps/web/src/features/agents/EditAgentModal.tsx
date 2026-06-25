import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, skills as skillsApi, ai as aiApi, type Agent, type CapabilityReadiness } from '../../lib/api-client.js';
import { Modal, Button, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { extractAgentObjective, formatExecutionMode, hasCapabilityFamily, listSelectableSkills, resolveSelectedSkills } from './agent-display.js';
import { SkillPicker } from './SkillPicker.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { ModelSelectionFields, resolveDefaultModelSelection } from '../settings/ModelSelectionFields.js';
import { buildUpdateAgentPayload, normalizeEscalationPolicy } from './agent-payloads.js';
import { validateCreateAgentForm, type ValidationConstraints } from './form-validation.js';
import { AgentControlsSection, TradingGuardrailsFields } from './AgentControlsSection.js';
import { formatTickIntervalMinutesForInput, getTickIntervalValidationMessageId, isWholeMinuteTickInterval } from './tick-interval.js';
import { CapabilitySelector, type CapabilityMode } from './CapabilitySelector.js';
import { TechnicalConfigSection } from './TechnicalConfigSection.js';
import { AdvancedSettingsSection } from './AdvancedSettingsSection.js';
import { defaultTechnicalConfigFormState, technicalConfigToFormState, technicalFormStateToPayload, type TechnicalConfigFormState } from './technical-config-helpers.js';

/**
 * Maps field names to the Advanced Settings tab index they live on.
 *   0 = AI Configuration
 *   2 = Trading Setup
 */
const ADVANCED_FIELD_TAB: Record<string, number> = {
  // AI Configuration
  tickIntervalMins: 0,
  dailySpendBudgetUsd: 0,
  // Trading Setup
  dailyLossLimit: 2,
  maxSlippageBps: 2,
  maxOpenPositions: 2,
  maxPositionSizePct: 2,
  stopLossPct: 2,
  stopLossCooldownSecs: 2,
  openPositionEscalationToJudgePolicy: 2,
};

interface EditAgentModalProps {
  agentId: string;
  onClose: () => void;
  initialData: Agent;
  isAdmin?: boolean;
}

interface FormState {
  name: string;
  prompt: string;
  capabilityMode: CapabilityMode;
  technicalConfig: TechnicalConfigFormState;
  skillIds: string[];
  executionMode: string;
  telegramChatId: string;
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd: string;
  dailyLossLimit: string;
  maxSlippageBps: string;
  maxOpenPositions: string;
  maxPositionSizePct: string;
  stopLossPct: string;
  stopLossCooldownSecs: string;
  tickIntervalMins: string;
  capital: string;
  openPositionEscalationToJudgePolicy: 'never' | 'uncovered_or_triggered' | 'always';
}

export function EditAgentModal({ agentId, onClose, initialData, isAdmin }: EditAgentModalProps) {
  const intl = useIntl();
  const qc = useQueryClient();
  const hasExplicitModelOverride = Boolean(initialData.provider || initialData.lightModel || initialData.heavyModel);
  const initialPrompt = extractAgentObjective(initialData.prompt);
  const initialCapabilityMode: CapabilityMode = initialData.technical
    ? (initialPrompt.trim() ? 'both' : 'technical')
    : 'intelligence';
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list({ scope: 'selectable' }),
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
  const initialTickIntervalIsLegacy = initialData.tickIntervalMs != null && !isWholeMinuteTickInterval(initialData.tickIntervalMs);

  const [form, setForm] = useState<FormState>({
    name: initialData.name,
    prompt: initialPrompt,
    capabilityMode: initialCapabilityMode,
    technicalConfig: initialData.technical
      ? technicalConfigToFormState(initialData.technical)
      : defaultTechnicalConfigFormState(),
    skillIds: initialData.skillIds ?? [],
    executionMode: initialData.executionMode ?? '',
    telegramChatId: initialData.telegramChatId ?? '',
    costPreset: (initialData.costPreset as FormState['costPreset']) ?? '',
    dailySpendBudgetUsd: initialData.dailySpendBudgetUsd != null ? String(initialData.dailySpendBudgetUsd) : '',
    dailyLossLimit: initialData.dailyLossLimit ?? '',
    maxSlippageBps: initialData.maxSlippageBps != null ? String(initialData.maxSlippageBps) : '',
    maxOpenPositions: initialData.maxOpenPositions != null ? String(initialData.maxOpenPositions) : '',
    maxPositionSizePct: initialData.maxPositionSizePct ?? '',
    stopLossPct: initialData.stopLossPct ?? '',
    stopLossCooldownSecs: initialData.stopLossCooldownMs != null ? String(initialData.stopLossCooldownMs / 1000) : '',
    tickIntervalMins: formatTickIntervalMinutesForInput(initialData.tickIntervalMs),
    capital: initialData.capital ?? '',
    openPositionEscalationToJudgePolicy: initialData.openPositionEscalationToJudgePolicy ?? 'uncovered_or_triggered',
  });
  const [tickIntervalTouched, setTickIntervalTouched] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [advancedExpandSeq, setAdvancedExpandSeq] = useState(0);
  const [advancedErrorTabIdx, setAdvancedErrorTabIdx] = useState(2);
  const [modelOverrideEnabled, setModelOverrideEnabled] = useState(hasExplicitModelOverride);
  const [modelForm, setModelForm] = useState({
    provider: initialData.provider ?? '',
    lightModel: initialData.lightModel ?? '',
    heavyModel: initialData.heavyModel ?? '',
  });
  const inheritedModelSettings = aiSettingsQuery.data?.aiModelConfig ?? null;
  const tradingCapabilityQuery = useQuery({
    queryKey: ['agents', agentId, 'capability-readiness', 'trading'],
    queryFn: async () => agentsApi.capabilityReadiness(agentId, 'trading') as Promise<CapabilityReadiness>,
  });
  const currentHasTradingCapability = tradingCapabilityQuery.data != null && tradingCapabilityQuery.data.state !== 'unconfigured';
  const riskDefaultsQuery = useQuery({
    queryKey: ['agents', 'risk-defaults'],
    queryFn: () => agentsApi.riskDefaults(),
  });
  const selectedSkills = resolveSelectedSkills(form.skillIds, selectableSkills);
  const hasBotManagementSkill = form.skillIds.includes('bot-management');
  const tickIntervalValidationMessageId = getTickIntervalValidationMessageId(form.tickIntervalMins);
  const tickIntervalError = tickIntervalValidationMessageId
    ? intl.formatMessage({ id: tickIntervalValidationMessageId })
    : null;
  const tickIntervalNotice = initialTickIntervalIsLegacy && !tickIntervalTouched && tickIntervalError == null
    ? intl.formatMessage({ id: 'agents.controls.tickInterval.legacyNotice' })
    : null;
  const effectiveTickIntervalMs = initialTickIntervalIsLegacy && !tickIntervalTouched
    ? (initialData.tickIntervalMs ?? null)
    : null;
  const showIntelligence = form.capabilityMode === 'intelligence' || form.capabilityMode === 'both';
  const showTechnical = form.capabilityMode === 'technical' || form.capabilityMode === 'both';
  const hasTradingCapability = showIntelligence && (skillsQuery.isSuccess
    ? hasCapabilityFamily(selectedSkills, 'trading')
    : currentHasTradingCapability);
  const showTradingControls = hasTradingCapability
    || Boolean(form.capital.trim() || form.dailyLossLimit.trim() || form.maxSlippageBps.trim() || form.maxOpenPositions.trim() || form.maxPositionSizePct.trim() || form.stopLossPct.trim() || form.stopLossCooldownSecs.trim());
  const validationConstraints: ValidationConstraints = {
    maxOpenPositions: riskDefaultsQuery.data?.maxOpenPositions ?? 10,
    maxPositionSizePct: riskDefaultsQuery.data?.maxPositionSizePct ?? 100,
    stopLossMaxUnrealizedLossPct: riskDefaultsQuery.data?.stopLossPct ?? 100,
  };

  useEffect(() => {
    if (!modelOverrideEnabled || modelForm.provider || inheritedModelSettings) {
      return;
    }
    const defaultSelection = resolveDefaultModelSelection(availableModelsQuery.data?.providers ?? []);
    if (!defaultSelection) {
      return;
    }
    setModelForm(defaultSelection);
  }, [availableModelsQuery.data?.providers, inheritedModelSettings, modelForm.provider, modelOverrideEnabled]);

  const set = (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }));

  function clearFieldError(field: string) {
    setFormErrors((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function bumpAdvancedExpand(errorKeys: string[]) {
    const advancedKey = errorKeys.find(k => k in ADVANCED_FIELD_TAB);
    if (advancedKey !== undefined) {
      setAdvancedErrorTabIdx(ADVANCED_FIELD_TAB[advancedKey]!);
      setAdvancedExpandSeq(s => s + 1);
    }
  }

  function validateFieldOnBlur(fieldName: string) {
    const result = validateCreateAgentForm({
      name: form.name,
      goal: form.prompt,
      capabilityMode: form.capabilityMode,
      capital: form.capital,
      tickIntervalMins: form.tickIntervalMins,
      maxOpenPositions: form.maxOpenPositions,
      maxPositionSizePct: form.maxPositionSizePct,
      stopLossPct: form.stopLossPct,
      // In edit mode, venue is managed via trading connection — always pass as truthy
      venue: 'connected',
      executionMode: form.executionMode,
      // Capital is optional in edit mode (blank = unlimited)
      requiresTradingSetup: false,
    }, validationConstraints);

    setFormErrors((prev) => {
      const fieldError = result.errors[fieldName];
      const hasExisting = fieldName in prev;
      if (!fieldError && !hasExisting) return prev;
      const next = { ...prev };
      if (fieldError) {
        next[fieldName] = fieldError;
      } else {
        delete next[fieldName];
      }
      return next;
    });

    if (result.errors[fieldName] && fieldName in ADVANCED_FIELD_TAB) {
      bumpAdvancedExpand([fieldName]);
    }
  }

  const mutation = useMutation({
    mutationFn: () => {
      const skillIds = Array.from(new Set([...preservedSkillIds, ...form.skillIds.filter((skillId) => selectableSkillIds.has(skillId))]));
      const technicalPayload = (form.capabilityMode === 'technical' || form.capabilityMode === 'both')
        ? technicalFormStateToPayload(form.technicalConfig)
        : null;
      return agentsApi.update(agentId, buildUpdateAgentPayload({
        name: form.name,
        prompt: form.prompt,
        capabilityMode: form.capabilityMode,
        technical: technicalPayload,
        skillIds,
        hasBotManagementSkill,
        executionMode: form.executionMode,
        hasTradingCapability,
        telegramChatId: form.telegramChatId,
        costPreset: form.costPreset,
        dailySpendBudgetUsd: form.dailySpendBudgetUsd,
        dailyLossLimit: form.dailyLossLimit,
        maxSlippageBps: form.maxSlippageBps,
        maxOpenPositions: form.maxOpenPositions,
        maxPositionSizePct: form.maxPositionSizePct,
        stopLossPct: form.stopLossPct,
        stopLossCooldownSecs: form.stopLossCooldownSecs,
        tickIntervalMins: form.tickIntervalMins,
        preserveOriginalTickIntervalMs: !tickIntervalTouched,
        originalTickIntervalMs: initialData.tickIntervalMs ?? null,
        capital: form.capital,
        openPositionEscalationToJudgePolicy: normalizeEscalationPolicy(form.openPositionEscalationToJudgePolicy),
        modelOverrideEnabled,
        modelForm,
      }));
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', agentId] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
      onClose();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = validateCreateAgentForm({
      name: form.name,
      goal: form.prompt,
      capabilityMode: form.capabilityMode,
      capital: form.capital,
      tickIntervalMins: form.tickIntervalMins,
      maxOpenPositions: form.maxOpenPositions,
      maxPositionSizePct: form.maxPositionSizePct,
      stopLossPct: form.stopLossPct,
      venue: 'connected',
      executionMode: form.executionMode,
      requiresTradingSetup: false,
    }, validationConstraints);
    if (!result.valid || tickIntervalError != null) {
      setFormErrors(result.errors);
      bumpAdvancedExpand(Object.keys(result.errors));
      return;
    }
    mutation.mutate();
  };
  const fieldGap: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '14px' };

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
          <div style={{ marginBottom: '14px' }}>
            <CapabilitySelector
              value={form.capabilityMode}
              onChange={(capabilityMode) => setForm((prev) => ({ ...prev, capabilityMode }))}
            />
          </div>

          {form.capabilityMode === 'technical' && initialCapabilityMode !== 'technical' && (
            <p style={{ fontSize: '12px', color: 'var(--color-warning)', background: 'var(--color-warning-subtle)', padding: '8px 10px', borderRadius: '6px', margin: '0 0 14px', lineHeight: '1.5' }}>
              {intl.formatMessage({ id: 'agents.edit.intelligenceIgnoredWarning' })}
            </p>
          )}

          <div style={fieldGap}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.edit.name' })}</FieldLabel>
            <input style={inputStyle} value={form.name} onChange={set('name')} required maxLength={100} />
          </div>

          {showIntelligence && (
          <div style={fieldGap}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.edit.objective' })}</FieldLabel>
            <textarea
              style={{ ...inputStyle, minHeight: '80px', resize: 'vertical' }}
              value={form.prompt}
              onChange={set('prompt')}
              required={showIntelligence}
              maxLength={4000}
            />
          </div>
          )}

          {showIntelligence && (
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
          )}

          {hasTradingCapability && (
            <div style={fieldGap}>
              <FieldLabel>{intl.formatMessage({ id: 'agents.executionMode.label' })}</FieldLabel>
              <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.executionMode} onChange={set('executionMode')}>
                <option value="">{intl.formatMessage({ id: 'agents.edit.executionModeUnset' })}</option>
                <option value="paper">{intl.formatMessage({ id: 'agents.create.executionMode.paper' })}</option>
                {isAdmin && <option value="shadow">{intl.formatMessage({ id: 'agents.create.executionMode.shadow' })}</option>}
                <option value="live">{intl.formatMessage({ id: 'agents.create.executionMode.live' })}</option>
              </select>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                {intl.formatMessage({ id: 'agents.edit.executionModeHelp' }, { mode: formatExecutionMode(form.executionMode, intl) })}
              </div>
            </div>
          )}

          {hasTradingCapability && (
            <div style={fieldGap}>
              <FieldLabel>{intl.formatMessage({ id: 'agents.controls.capital' })}</FieldLabel>
              <input
                style={inputStyle}
                value={form.capital}
                onChange={set('capital')}
                placeholder={intl.formatMessage({ id: 'common.unlimited' })}
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                {intl.formatMessage({ id: 'agents.controls.capital.help' })}
              </div>
            </div>
          )}

          <div style={fieldGap}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.edit.telegramChatId' })}</FieldLabel>
            <input style={inputStyle} value={form.telegramChatId} onChange={set('telegramChatId')} placeholder={intl.formatMessage({ id: 'common.optional' })} />
          </div>

          <AdvancedSettingsSection
            expandSeq={advancedExpandSeq}
            errorTabIdx={advancedErrorTabIdx}
            aiConfig={
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {showIntelligence && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface-1)' }}>
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
                                provider: inheritedModelSettings.provider ?? '',
                                lightModel: inheritedModelSettings.lightModel ?? '',
                                heavyModel: inheritedModelSettings.heavyModel ?? '',
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
                )}

                <AgentControlsSection
                  value={{
                    costPreset: form.costPreset,
                    dailySpendBudgetUsd: form.dailySpendBudgetUsd,
                    tickIntervalMins: form.tickIntervalMins,
                    dailyLossLimit: form.dailyLossLimit,
                    maxSlippageBps: form.maxSlippageBps,
                    maxOpenPositions: form.maxOpenPositions,
                    maxPositionSizePct: form.maxPositionSizePct,
                    stopLossPct: form.stopLossPct,
                    stopLossCooldownSecs: form.stopLossCooldownSecs,
                  }}
                  showBotControls={hasBotManagementSkill}
                  tickIntervalError={tickIntervalError}
                  tickIntervalNotice={tickIntervalNotice}
                  effectiveTickIntervalMs={effectiveTickIntervalMs}
                  fieldErrors={formErrors}
                  onClearFieldError={clearFieldError}
                  onBlurField={validateFieldOnBlur}
                  onChange={(patch) => {
                    if (patch.tickIntervalMins !== undefined) {
                      setTickIntervalTouched(true);
                    }
                    setForm((prev) => ({ ...prev, ...patch }));
                  }}
                />
              </div>
            }
            skills={null}
            tradingSetup={
              showTradingControls ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ fontSize: '14px', fontWeight: '600' }}>
                    {intl.formatMessage({ id: 'agents.create.tradingControls.title' })}
                  </div>
                  <TradingGuardrailsFields
                    value={{
                      dailyLossLimit: form.dailyLossLimit,
                      maxSlippageBps: form.maxSlippageBps,
                      maxOpenPositions: form.maxOpenPositions,
                      maxPositionSizePct: form.maxPositionSizePct,
                      stopLossPct: form.stopLossPct,
                      stopLossCooldownSecs: form.stopLossCooldownSecs,
                      openPositionEscalationToJudgePolicy: form.openPositionEscalationToJudgePolicy,
                    }}
                    defaults={riskDefaultsQuery.data ?? null}
                    fieldErrors={formErrors}
                    onClearFieldError={clearFieldError}
                    onBlurField={validateFieldOnBlur}
                    onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
                  />
                </div>
              ) : null
            }
            strategy={
              showTechnical ? (
                <div style={{ padding: '12px', border: '1px solid var(--color-border)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '13px', fontWeight: '600', marginBottom: '12px' }}>
                    {intl.formatMessage({ id: 'agents.technical.title' })}
                  </div>
                  <TechnicalConfigSection
                    value={form.technicalConfig}
                    onChange={(technicalConfig) => setForm((prev) => ({ ...prev, technicalConfig }))}
                    showErrors={Object.keys(formErrors).length > 0}
                    onClearFieldError={clearFieldError}
                  />
                </div>
              ) : null
            }
          />
        </form>
      </div>

      {mutation.isError && <ErrorBanner message={localizeApiError(intl, mutation.error, 'common.errorTitle')} />}

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '20px' }}>
        <Button variant="ghost" onClick={onClose} type="button">{intl.formatMessage({ id: 'common.cancel' })}</Button>
        <Button
          variant="primary"
          type="submit"
          form="edit-agent-form"
          disabled={mutation.isPending
            || !form.name.trim()
            || (showIntelligence && !form.prompt.trim())
            || tickIntervalError != null
            || (modelOverrideEnabled && (!modelForm.provider || !modelForm.lightModel || !modelForm.heavyModel))}
        >
          {mutation.isPending ? intl.formatMessage({ id: 'agents.edit.saving' }) : intl.formatMessage({ id: 'common.saveChanges' })}
        </Button>
      </div>
    </Modal>
  );
}
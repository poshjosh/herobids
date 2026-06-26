import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, skills as skillsApi, ai as aiApi, type Agent, type CapabilityReadiness } from '../../lib/api-client.js';
import { Modal, Button, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { formatExecutionMode, hasCapabilityFamily, listSelectableSkills, resolveSelectedSkills, resolveSkillPresetSkillIds, type SkillPresetId } from './agent-display.js';
import { SkillPicker } from './SkillPicker.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { ModelSelectionFields, resolveDefaultModelSelection } from '../settings/ModelSelectionFields.js';
import { buildUpdateAgentPayload, normalizeEscalationPolicy } from './agent-payloads.js';
import { validateCreateAgentForm, type ValidationConstraints } from './form-validation.js';
import { TradingGuardrailsFields } from './AgentControlsSection.js';
import { getTickIntervalValidationMessageId, isWholeMinuteTickInterval } from './tick-interval.js';
import { type CapabilityMode } from './CapabilitySelector.js';
import { deriveCapabilityMode } from './derive-capability-mode.js';
import { StyleSelector } from './StyleSelector.js';
import { type AgentStyleValue, resolveStyleDefaults } from './style-mapping.js';
import { technicalFormStateToPayload } from './technical-config-helpers.js';
import { AgentFormBody } from './AgentFormBody.js';
import { type AgentFormState, agentToFormState } from './agent-form-state.js';

interface EditAgentModalProps {
  agentId: string;
  onClose: () => void;
  initialData: Agent;
  isAdmin?: boolean;
}

/** Fixed skill sets matching SKILL_PRESET_SKILL_IDS in agent-display.ts. */
const TRADING_SKILL_IDS = ['bot-management', 'trading'];
const ASSISTANT_SKILL_IDS = ['task-management', 'web-access'];

function resolvePresetFromSkillIds(skillIds: string[]): SkillPresetId {
  if (skillIds.length === 0) return 'custom';
  const set = new Set(skillIds);
  if (TRADING_SKILL_IDS.every((id) => set.has(id))) return 'trading';
  if (ASSISTANT_SKILL_IDS.every((id) => set.has(id))) return 'personal-assistant';
  return 'custom';
}

export function EditAgentModal({ agentId, onClose, initialData, isAdmin }: EditAgentModalProps) {
  const intl = useIntl();
  const qc = useQueryClient();
  const hasExplicitModelOverride = Boolean(initialData.provider || initialData.lightModel || initialData.heavyModel);
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

  const policyManuallySetRef = useRef(false);
  const [form, setForm] = useState<AgentFormState>(() => agentToFormState(initialData));
  const [style, setStyle] = useState<AgentStyleValue>(
    (initialData.style as AgentStyleValue) ?? 'balanced',
  );
  const [skillPreset, setSkillPreset] = useState<SkillPresetId>(() =>
    resolvePresetFromSkillIds(initialData.skillIds ?? []),
  );
  const [tickIntervalTouched, setTickIntervalTouched] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
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

  // Derive capabilityMode from skill selection + goal text (same logic as create form)
  useEffect(() => {
    setForm((state) => {
      const resolvedSkills = selectableSkills.filter((s) => state.skillIds.includes(s.id));
      const syntheticTradingSkill =
        skillPreset === 'trading' ? [{ capabilityFamilies: ['trading'] }] : [];
      const effectiveSkills =
        resolvedSkills.length > 0 ? resolvedSkills : syntheticTradingSkill;
      const derived = deriveCapabilityMode(effectiveSkills, state.goal);
      if (derived !== state.capabilityMode) {
        return { ...state, capabilityMode: derived };
      }
      return state;
    });
  }, [form.skillIds, form.goal, selectableSkills, skillPreset]);

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

  function clearFieldError(field: string) {
    setFormErrors((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function validateFieldOnBlur(fieldName: string) {
    const result = validateCreateAgentForm({
      name: form.name,
      goal: form.goal,
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
  }

  const mutation = useMutation({
    mutationFn: () => {
      const skillIds = Array.from(new Set([...preservedSkillIds, ...form.skillIds.filter((skillId) => selectableSkillIds.has(skillId))]));
      const technicalPayload = (form.capabilityMode === 'technical' || form.capabilityMode === 'both')
        ? technicalFormStateToPayload(form.technicalConfig)
        : null;
      return agentsApi.update(agentId, buildUpdateAgentPayload({
        name: form.name,
        prompt: form.goal,
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
        style,
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
      goal: form.goal,
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
      return;
    }
    mutation.mutate();
  };

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
          {/* Skill Preset — same label as create agent form */}
          <div style={{ marginBottom: '14px' }}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.create.skillPreset' })}</FieldLabel>
            <select
              value={skillPreset}
              onChange={(e) => {
                const preset = e.target.value as SkillPresetId;
                setSkillPreset(preset);
                setForm((prev) => ({
                  ...prev,
                  skillIds: resolveSkillPresetSkillIds(preset, prev.skillIds),
                }));
              }}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="trading">{intl.formatMessage({ id: 'agents.create.skillPreset.trading' })}</option>
              <option value="personal-assistant">{intl.formatMessage({ id: 'agents.create.skillPreset.personalAssistant' })}</option>
              <option value="custom">{intl.formatMessage({ id: 'agents.create.skillPreset.custom' })}</option>
            </select>
          </div>

          {/* Goal */}
          <div data-field="goal" style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '14px' }}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.edit.objective' })}</FieldLabel>
            <textarea
              style={{ ...inputStyle, minHeight: '72px', resize: 'vertical' }}
              value={form.goal}
              onChange={(e) => {
                clearFieldError('goal');
                setForm((prev) => ({ ...prev, goal: e.target.value }));
              }}
              onBlur={() => validateFieldOnBlur('goal')}
              placeholder={intl.formatMessage({ id: 'agents.create.goalPlaceholder' })}
              required
            />
            {formErrors.goal && <div style={{ color: 'var(--color-danger)', fontSize: '12px', marginTop: '4px' }}>{formErrors.goal}</div>}
          </div>

          {/* Agent Style */}
          <StyleSelector
            value={style}
            onChange={(nextStyle) => {
              const defaults = resolveStyleDefaults(nextStyle);
              setStyle(nextStyle);
              setForm((prev) => ({
                ...prev,
                costPreset: defaults.costPreset,
                tickIntervalMins: defaults.tickIntervalMins,
                dailySpendBudgetUsd: defaults.dailySpendBudgetUsd,
                ...(policyManuallySetRef.current
                  ? {}
                  : { openPositionEscalationToJudgePolicy: defaults.openPositionEscalationToJudgePolicy }),
              }));
            }}
          />

          <AgentFormBody
            value={form}
            onChange={(patch) => {
              if (patch.tickIntervalMins !== undefined) setTickIntervalTouched(true);
              setForm((s) => ({ ...s, ...patch }));
            }}
            showIntelligence={showIntelligence}
            showTechnical={showTechnical}
            showTradingControls={showTradingControls}
            requiresTradingSetup={false}
            isAdmin={isAdmin ?? false}
            selectableSkills={selectableSkills}
            skillsLoading={skillsQuery.isLoading}
            skillsError={skillsQuery.error instanceof Error ? skillsQuery.error.message : null}
            formErrors={formErrors}
            onClearFieldError={clearFieldError}
            onBlurField={validateFieldOnBlur}
            validationConstraints={validationConstraints}
            tickIntervalError={tickIntervalError}
            tickIntervalNotice={tickIntervalNotice}
            effectiveTickIntervalMs={effectiveTickIntervalMs}
            modelSlot={
              showIntelligence ? (
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
              ) : null
            }
            skillsSlot={
              showIntelligence ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
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
              ) : null
            }
            tradingSetupSlot={
              showTradingControls ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {hasTradingCapability && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <FieldLabel>{intl.formatMessage({ id: 'agents.executionMode.label' })}</FieldLabel>
                      <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.executionMode} onChange={(e) => setForm((prev) => ({ ...prev, executionMode: e.target.value }))}>
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
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <FieldLabel>{intl.formatMessage({ id: 'agents.controls.capital' })}</FieldLabel>
                      <input
                        style={inputStyle}
                        value={form.capital}
                        onChange={(e) => setForm((prev) => ({ ...prev, capital: e.target.value }))}
                        placeholder={intl.formatMessage({ id: 'common.unlimited' })}
                      />
                      <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                        {intl.formatMessage({ id: 'agents.controls.capital.help' })}
                      </div>
                    </div>
                  )}

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
            || (showIntelligence && !form.goal.trim())
            || tickIntervalError != null
            || (modelOverrideEnabled && (!modelForm.provider || !modelForm.lightModel || !modelForm.heavyModel))}
        >
          {mutation.isPending ? intl.formatMessage({ id: 'agents.edit.saving' }) : intl.formatMessage({ id: 'common.saveChanges' })}
        </Button>
      </div>
    </Modal>
  );
}
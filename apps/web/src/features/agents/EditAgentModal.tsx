import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, capabilities as capabilitiesApi, skills as skillsApi, ai as aiApi, providerCatalog as providerCatalogApi, type Agent, type CapabilityReadiness } from '../../lib/api-client.js';
import { Modal, Button, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { formatExecutionMode, hasCapabilityFamily, listSelectableSkills, resolveSelectedSkills, resolveSkillPresetSkillIds, resolvePromptTemplate, resolveGoalPlaceholder, type SkillPresetId } from './agent-display.js';
import { SkillPicker } from './SkillPicker.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { ModelSelectionFields, resolveDefaultModelSelection } from '../settings/ModelSelectionFields.js';
import { buildUpdateAgentPayload, normalizeEscalationPolicy } from './agent-payloads.js';
import { validateCreateAgentForm, type ValidationConstraints } from './form-validation.js';
import { TradingGuardrailsFields } from './AgentControlsSection.js';
import { getTickIntervalValidationMessageId, isWholeMinuteTickInterval, parseTickIntervalMinutesInput } from './tick-interval.js';
import { type CapabilityMode } from './CapabilitySelector.js';
import { StyleSelector } from './StyleSelector.js';
import { applyAutoMaxHoldOverride, type AgentStyleValue, resolveStyleDefaults, formatStyleSummary, resolveModelPricing, type RuntimePolicyOverrides } from './style-mapping.js';
import { technicalFormStateToPayload } from './technical-config-helpers.js';
import { VENUE_TYPE_MAP, buildVenueTypeMap } from './venue-mapping.js';
import { AgentFormBody } from './AgentFormBody.js';
import { type AgentFormState, agentToFormState } from './agent-form-state.js';
import { RuntimePolicySection } from './RuntimePolicySection.js';

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

  const sorted = [...skillIds].sort();
  const setsEqual = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i]);

  if (setsEqual(sorted, [...TRADING_SKILL_IDS].sort())) return 'trading';
  if (setsEqual(sorted, [...ASSISTANT_SKILL_IDS].sort())) return 'personal-assistant';
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
  const maxHoldDurationManuallySetRef = useRef(
    Object.prototype.hasOwnProperty.call((initialData.runtimePolicyOverrides as RuntimePolicyOverrides | null) ?? {}, 'maxHoldDurationMs'),
  );
  const [form, setForm] = useState<AgentFormState>(() => agentToFormState(initialData));
  const [style, setStyle] = useState<AgentStyleValue>(
    (initialData.style as AgentStyleValue) ?? 'balanced',
  );
  const [runtimePolicyOverrides, setRuntimePolicyOverrides] = useState<RuntimePolicyOverrides | null>(
    (initialData.runtimePolicyOverrides as RuntimePolicyOverrides | null) ?? null,
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
  const agentConnectionsQuery = useQuery({
    queryKey: ['agents', agentId, 'capabilities', 'trading', 'connections'],
    queryFn: () => agentsApi.tradingConnections(agentId),
  });
  const availableConnectionsQuery = useQuery({
    queryKey: ['capabilities', 'trading', 'connections'],
    queryFn: () => capabilitiesApi.tradingConnections(),
  });
  const providerCatalogQuery = useQuery({
    queryKey: ['providerCatalog'],
    queryFn: () => providerCatalogApi.get(),
    staleTime: 60 * 60 * 1000,
  });

  const venueTypeMap = providerCatalogQuery.data?.providers
    ? buildVenueTypeMap(providerCatalogQuery.data.providers)
    : VENUE_TYPE_MAP;
  const availableConnections = (availableConnectionsQuery.data?.connections ?? []).filter(
    (connection) => connection.status === 'active',
  );

  // Initialize connectionIds from the agent's current connections
  useEffect(() => {
    if (!agentConnectionsQuery.isSuccess) return;
    const activeIds = (agentConnectionsQuery.data?.connections ?? [])
      .filter((c) => c.grantStatus === 'active')
      .map((c) => c.connectionId);
    setForm((prev) => {
      // Only update if different to avoid infinite loops
      const prevIds = prev.connectionIds ?? [];
      if (prevIds.length === activeIds.length && prevIds.every((id) => activeIds.includes(id))) {
        return prev;
      }
      return { ...prev, connectionIds: activeIds };
    });
  }, [agentConnectionsQuery.isSuccess, agentConnectionsQuery.data?.connections]);

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

  function resolveEditedTickIntervalMs(tickIntervalMins: string, forceExplicit = false): number | null {
    if (initialTickIntervalIsLegacy && !tickIntervalTouched && !forceExplicit) {
      return initialData.tickIntervalMs ?? null;
    }

    const parsed = parseTickIntervalMinutesInput(tickIntervalMins);
    return parsed.kind === 'valid' ? parsed.tickIntervalMs : null;
  }
  const showIntelligence = form.capabilityMode === 'intelligence' || form.capabilityMode === 'both';
  const requiresTradingSetup = skillPreset === 'trading' || hasCapabilityFamily(selectedSkills, 'trading');
  // Short-circuit to false when a non-trading preset (Custom or
  // Personal Assistant) is selected — no trading skills are inferred
  // and we don't want the fallback to currentHasTradingCapability keeping
  // the trading tab visible while the skills query is still loading.
  const hasTradingCapability = (skillPreset === 'trading' || hasCapabilityFamily(selectedSkills, 'trading')) && showIntelligence && (skillsQuery.isSuccess
    ? hasCapabilityFamily(selectedSkills, 'trading')
    : currentHasTradingCapability);
  // Field-value fallback: show trading controls whenever stored values are present,
  // including agents that have trading values but no explicit trading skills (custom
  // preset derived from empty skillIds). When the user explicitly picks a non-trading
  // preset (Custom or Personal Assistant), the preset change handler clears all
  // values synchronously, so this naturally becomes false without needing a
  // skillPreset gate.
  const showTradingControls = requiresTradingSetup || hasTradingCapability
    || Boolean(form.capital.trim() || form.dailyLossLimit.trim() || form.maxDrawdownPct.trim() || form.maxSlippageBps.trim() || form.maxOpenPositions.trim() || form.maxPositionSizePct.trim() || form.stopLossPct.trim() || form.stopLossCooldownSecs.trim());
  const validationConstraints: ValidationConstraints = {
    maxOpenPositions: riskDefaultsQuery.data?.maxOpenPositions ?? 10,
    maxPositionSizePct: riskDefaultsQuery.data?.maxPositionSizePct ?? 100,
    stopLossMaxUnrealizedLossPct: riskDefaultsQuery.data?.stopLossPct ?? 100,
  };

  // Sync capabilityMode from technicalPreFilterEnabled toggle + trading skill presence
  useEffect(() => {
    setForm((state) => {
      const resolvedSkills = selectableSkills.filter((s) => state.skillIds.includes(s.id));
      const syntheticTradingSkill =
        skillPreset === 'trading' ? [{ capabilityFamilies: ['trading'] }] : [];
      const effectiveSkills =
        resolvedSkills.length > 0 ? resolvedSkills : syntheticTradingSkill;
      const hasTradingSkill = hasCapabilityFamily(effectiveSkills, 'trading');
      const derived: CapabilityMode = state.technicalPreFilterEnabled && hasTradingSkill ? 'both' : 'intelligence';
      if (derived !== state.capabilityMode) {
        return { ...state, capabilityMode: derived };
      }
      return state;
    });
  }, [form.skillIds, form.technicalPreFilterEnabled, selectableSkills, skillPreset]);

  // Pre-fill goal from promptTemplate when skills change and goal is empty
  useEffect(() => {
    if (form.goal.trim()) return;
    if (!skillsQuery.data) return;
    const template = resolvePromptTemplate(form.skillIds, skillsQuery.data.skills);
    if (template) {
      setForm((prev) => ({ ...prev, goal: template }));
    }
  }, [form.skillIds, skillsQuery.data]);

  useEffect(() => {
    if (!modelOverrideEnabled || modelForm.provider || inheritedModelSettings) {
      return;
    }
    const defaultSelection = resolveDefaultModelSelection(availableModelsQuery.data?.providers ?? [], availableModelsQuery.data?.defaults);
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
      const activeConnection = agentConnectionsQuery.data?.connections
        ?.find(c => c.grantStatus === 'active' && c.connectionStatus === 'active');
      const connectionVenue = activeConnection?.provider ?? '';
      const connectionVenueType = (venueTypeMap[connectionVenue] ?? '') as '' | 'orderbook' | 'swap';
      const hasStrategyPreset = form.strategyPreset && form.strategyPreset !== 'custom';
      const technicalPayload = (!hasStrategyPreset && form.technicalPreFilterEnabled)
        ? technicalFormStateToPayload(form.technicalConfig, connectionVenue || undefined, connectionVenueType || undefined)
        : null;
      return agentsApi.update(agentId, buildUpdateAgentPayload({
        name: form.name,
        prompt: form.goal,
        capabilityMode: form.capabilityMode,
        technicalPreFilterEnabled: form.technicalPreFilterEnabled,
        technical: technicalPayload,
        strategyPreset: hasStrategyPreset
          ? form.strategyPreset
          : (initialData.strategyPreset ? null : undefined),
        skillIds,
        hasBotManagementSkill,
        executionMode: form.executionMode,
        hasTradingCapability,
        connectionIds: (form.connectionIds ?? []).length > 0 ? form.connectionIds : undefined,
        telegramChatId: form.telegramChatId,
        costPreset: form.costPreset,
        dailySpendBudgetUsd: form.dailySpendBudgetUsd,
        dailyLossLimit: form.dailyLossLimit,
        maxDrawdownPct: form.maxDrawdownPct,
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
        runtimePolicyOverrides: runtimePolicyOverrides ?? undefined,
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
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
                  // Clear trading values when switching to a non-trading preset
                  // so stale values don't keep trading UI visible via the
                  // field-value fallback in showTradingControls.
                  ...(preset !== 'trading' ? {
                    executionMode: '' as const,
                    capital: '',
                    dailyLossLimit: '',
                    maxDrawdownPct: '',
                    maxSlippageBps: '',
                    maxOpenPositions: '',
                    maxPositionSizePct: '',
                    stopLossPct: '',
                    stopLossCooldownSecs: '',
                  } : {}),
                }));
                // Clear trading session overrides when switching away from trading
                // so the hour grid (0-23) becomes editable again.
                if (preset !== 'trading') {
                  setRuntimePolicyOverrides((current) => {
                    if (!current?.tradingSessions) return current;
                    const { tradingSessions: _, ...rest } = current;
                    return Object.keys(rest).length > 0 ? rest : null;
                  });
                }
              }}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="trading">{intl.formatMessage({ id: 'agents.create.skillPreset.trading' })}</option>
              <option value="personal-assistant">{intl.formatMessage({ id: 'agents.create.skillPreset.personalAssistant' })}</option>
              <option value="custom">{intl.formatMessage({ id: 'agents.create.skillPreset.custom' })}</option>
            </select>
            {skillPreset !== 'custom' && selectedSkills.length > 0 && (
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.4' }}>
                {selectedSkills.map((s) => s.name).join(', ')}
              </div>
            )}
          </div>

          {/* Custom skill picker — shown inline when custom preset is selected */}
          {skillPreset === 'custom' && (
            <div style={{ marginBottom: '14px' }}>
              <SkillPicker
                skills={selectableSkills}
                selectedSkillIds={form.skillIds}
                onChange={(skillIds) => setForm((prev) => ({ ...prev, skillIds }))}
                loading={skillsQuery.isLoading}
                errorMessage={skillsQuery.error instanceof Error ? skillsQuery.error.message : null}
              />
            </div>
          )}

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
              placeholder={skillsQuery.data
                ? (resolveGoalPlaceholder(form.skillIds, skillsQuery.data.skills) ?? intl.formatMessage({ id: 'agents.create.goalPlaceholder' }))
                : intl.formatMessage({ id: 'agents.create.goalPlaceholder' })}
              required
            />
            {formErrors.goal && <div style={{ color: 'var(--color-danger)', fontSize: '12px', marginTop: '4px' }}>{formErrors.goal}</div>}
          </div>

          {/* Agent Style */}
          <div style={{ marginBottom: '14px' }}>
            <StyleSelector
              value={style}
              onChange={(nextStyle) => {
                const defaults = resolveStyleDefaults(nextStyle);
                setTickIntervalTouched(true);
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
                if (!maxHoldDurationManuallySetRef.current) {
                  setRuntimePolicyOverrides((current) => applyAutoMaxHoldOverride(
                    nextStyle,
                    current,
                    Number(defaults.tickIntervalMins) * 60_000,
                  ));
                } else {
                  const newTickMs = Number(defaults.tickIntervalMins) * 60_000;
                  setRuntimePolicyOverrides((current) => {
                    const effectiveMaxHold = current?.maxHoldDurationMs
                      ?? resolveStyleDefaults(nextStyle).maxHoldDurationMs;
                    return effectiveMaxHold !== 0 && effectiveMaxHold < newTickMs
                      ? applyAutoMaxHoldOverride(nextStyle, current, newTickMs)
                      : current;
                  });
                }
              }}
            />
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
              {intl.formatMessage({ id: 'agents.style.summaryPrefix' })}{' '}
              {formatStyleSummary(
                style,
                resolveModelPricing(
                  availableModelsQuery.data?.providers ?? [],
                  modelOverrideEnabled ? modelForm.provider : (inheritedModelSettings?.provider ?? ''),
                  modelOverrideEnabled ? modelForm.lightModel : (inheritedModelSettings?.lightModel ?? ''),
                  modelOverrideEnabled ? modelForm.heavyModel : (inheritedModelSettings?.heavyModel ?? ''),
                ),
                resolveEditedTickIntervalMs(form.tickIntervalMins),
              )}
            </div>
          </div>

          <AgentFormBody
            value={form}
            onChange={(patch) => {
              const nextForm = { ...form, ...patch };
              if (patch.tickIntervalMins !== undefined) {
                setTickIntervalTouched(true);
                const newTickMs = resolveEditedTickIntervalMs(nextForm.tickIntervalMins, true);
                if (!maxHoldDurationManuallySetRef.current) {
                  setRuntimePolicyOverrides((current) => applyAutoMaxHoldOverride(
                    style,
                    current,
                    newTickMs,
                  ));
                } else {
                  setRuntimePolicyOverrides((current) => {
                    const effectiveMaxHold = current?.maxHoldDurationMs
                      ?? resolveStyleDefaults(style).maxHoldDurationMs;
                    return newTickMs != null && effectiveMaxHold !== 0 && effectiveMaxHold < newTickMs
                      ? applyAutoMaxHoldOverride(style, current, newTickMs)
                      : current;
                  });
                }
              }
              setForm(nextForm);
            }}
            showIntelligence={showIntelligence}
            showTradingControls={showTradingControls}
            requiresTradingSetup={requiresTradingSetup}
            isAdmin={isAdmin ?? false}
            agentStyle={style}
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
            computeBudgetSlot={
              <RuntimePolicySection
                style={style}
                overrides={runtimePolicyOverrides}
                onChange={(overrides) => {
                  const hasManualMaxHoldOverride = Object.prototype.hasOwnProperty.call(overrides ?? {}, 'maxHoldDurationMs');
                  maxHoldDurationManuallySetRef.current = hasManualMaxHoldOverride;
                  if (hasManualMaxHoldOverride) {
                    clearFieldError('tickIntervalMins');
                  }
                  setRuntimePolicyOverrides(
                    hasManualMaxHoldOverride
                      ? overrides
                      : applyAutoMaxHoldOverride(
                          style,
                          overrides,
                          resolveEditedTickIntervalMs(form.tickIntervalMins),
                        ),
                  );
                }}
                alwaysExpanded
                showTradingSessionPresets={showTradingControls}
              />
            }
            connectionSlot={
              showTradingControls ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <FieldLabel>{intl.formatMessage({ id: 'agents.create.whereToTrade' })}</FieldLabel>
                  {availableConnectionsQuery.isLoading ? (
                    <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.create.loadingConnections' })}</div>
                  ) : availableConnections.length === 0 ? (
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                      {intl.formatMessage({ id: 'agents.create.noConnections' })}
                    </div>
                  ) : (
                    <>
                      <select
                        value=""
                        onChange={(e) => {
                          const id = e.target.value;
                          if (!id) return;
                          setForm((prev) => {
                            const currentIds = prev.connectionIds ?? [];
                            return currentIds.includes(id)
                              ? prev
                              : { ...prev, connectionIds: [...currentIds, id] };
                          });
                        }}
                        style={{ ...inputStyle, cursor: 'pointer' }}
                      >
                        <option value="">{intl.formatMessage({ id: 'agents.create.chooseConnection' })}</option>
                        {availableConnections.map((connection) => (
                          <option key={connection.connectionId} value={connection.connectionId}>
                            {connection.label} ({connection.provider})
                          </option>
                        ))}
                      </select>
                      {(form.connectionIds ?? []).length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {(form.connectionIds ?? []).map((id) => {
                            const conn = availableConnections.find((c) => c.connectionId === id);
                            return (
                              <span
                                key={id}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  padding: '2px 8px',
                                  borderRadius: '12px',
                                  background: 'var(--color-surface-2)',
                                  fontSize: '12px',
                                  cursor: 'default',
                                }}
                              >
                                {conn?.label ?? id}
                                <button
                                  type="button"
                                  onClick={() => setForm((prev) => ({
                                    ...prev,
                                    connectionIds: (prev.connectionIds ?? []).filter((cid) => cid !== id),
                                  }))}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: '0 2px',
                                    fontSize: '14px',
                                    lineHeight: '1',
                                    color: 'var(--color-text-muted)',
                                  }}
                                >
                                  ×
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : null
            }
            modelSlot={
              showIntelligence ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
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
            tradingSetupSlot={
              showTradingControls ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {(requiresTradingSetup || hasTradingCapability) && (
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

                  <div style={{ fontSize: '14px', fontWeight: '600' }}>
                    {intl.formatMessage({ id: 'agents.create.tradingControls.title' })}
                  </div>
                  <TradingGuardrailsFields
                    value={{
                      dailyLossLimit: form.dailyLossLimit,
                      maxDrawdownPct: form.maxDrawdownPct,
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
                    onChange={(patch) => {
                      if ('openPositionEscalationToJudgePolicy' in patch) {
                        policyManuallySetRef.current = true;
                      }
                      setForm((prev) => ({ ...prev, ...patch }));
                    }}
                  />
                </div>
              ) : null
            }
          />
        </form>

        {mutation.isError && <ErrorBanner message={localizeApiError(intl, mutation.error, 'common.errorTitle')} />}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
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
      </div>
    </Modal>
  );
}
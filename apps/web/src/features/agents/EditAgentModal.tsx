import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { getAllowedReasoningLevels, RUNTIME_POLICY_CEILINGS } from '@herobids/domain';
import { agents as agentsApi, capabilities as capabilitiesApi, connections as connectionsApi, skills as skillsApi, ai as aiApi, providerCatalog as providerCatalogApi, auth as authApi, type Agent, type CapabilityReadiness } from '../../lib/api-client.js';
import { Modal, Button, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { formatExecutionMode, hasCapabilityFamily, listSelectableSkills, resolveSelectedSkills, resolveSkillPresetSkillIds, resolvePromptTemplate, resolveGoalPlaceholderKey, type SkillPresetId } from './agent-display.js';
import { SkillPicker } from './SkillPicker.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { ModelSelectionFields, resolveDefaultModelSelection } from '../settings/ModelSelectionFields.js';
import { buildUpdateAgentPayload, normalizeEscalationPolicy } from './agent-payloads.js';
import { validateCreateAgentForm, validateEditAgentConnections, type ValidationConstraints } from './form-validation.js';
import { TradingGuardrailsFields } from './AgentControlsSection.js';
import { getTickIntervalValidationMessageId, isWholeMinuteTickInterval, parseTickIntervalMinutesInput } from './tick-interval.js';
import { type CapabilityMode, type HybridMode } from './CapabilitySelector.js';
import { applyAutoMaxHoldOverride, type AgentStyleValue, resolveStyleDefaults, formatStyleSummary, resolveModelPricing, type RuntimePolicyOverrides } from './style-mapping.js';

const STYLE_LABEL_KEYS: Record<AgentStyleValue, string> = {
  careful: 'agents.style.careful.label',
  balanced: 'agents.style.balanced.label',
  bold: 'agents.style.bold.label',
};
import { technicalFormStateToPayload } from './technical-config-helpers.js';
import { VENUE_TYPE_MAP, buildVenueTypeMap } from './venue-mapping.js';
import { PromptInputBlock } from './PromptInputBlock.js';
import { AgentFormBody } from './AgentFormBody.js';
import { type AgentFormState, agentToFormState } from './agent-form-state.js';
import { RuntimePolicySection } from './RuntimePolicySection.js';
import { ProviderSetupForm } from '../setup/ProviderSetupForm.js';
import {
  saveEditAgentOAuthDraft,
  loadEditAgentOAuthDraft,
  clearEditAgentOAuthDraft,
  applyOAuthReturnToForm,
} from './edit-agent-oauth-draft.js';

interface EditAgentModalProps {
  agentId: string;
  onClose: () => void;
  initialData: Agent;
  isAdmin?: boolean;
}

/** Fixed skill sets matching SKILL_PRESET_SKILL_IDS in agent-display.ts. */
const TRADING_SKILL_IDS = ['bot-management', 'trading'];
const DIRECT_TRADING_SKILL_IDS = ['trading'];
const ASSISTANT_SKILL_IDS = ['task-management', 'web-access'];

function resolvePresetFromSkillIds(skillIds: string[], skillPresetId?: string | null): SkillPresetId {
  // Prefer the persisted skillPresetId when available (handles direct-trading and
  // trading-assistant which share the same ['trading'] skill array).
  if (skillPresetId) {
    const validPresets: SkillPresetId[] = ['trading', 'direct-trading', 'trading-assistant', 'personal-assistant', 'custom'];
    if (validPresets.includes(skillPresetId as SkillPresetId)) {
      return skillPresetId as SkillPresetId;
    }
  }

  if (skillIds.length === 0) return 'custom';

  const sorted = [...skillIds].sort();
  const setsEqual = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i]);

  if (setsEqual(sorted, [...TRADING_SKILL_IDS].sort())) return 'trading';
  if (setsEqual(sorted, [...DIRECT_TRADING_SKILL_IDS].sort())) return 'direct-trading';
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
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me(),
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
    resolvePresetFromSkillIds(initialData.skillIds ?? [], initialData.skillPresetId),
  );
  const executionModeTouchedRef = useRef(false);
  const [tickIntervalTouched, setTickIntervalTouched] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showAddConnection, setShowAddConnection] = useState(false);
  const [modelOverrideEnabled, setModelOverrideEnabled] = useState(hasExplicitModelOverride);
  const [modelForm, setModelForm] = useState({
    provider: initialData.provider ?? '',
    lightModel: initialData.lightModel ?? '',
    heavyModel: initialData.heavyModel ?? '',
  });
  const inheritedModelSettings = aiSettingsQuery.data?.aiModelConfig ?? null;

  // OAuth return handling — restore draft after redirect back from provider.
  // Uses window.location directly (not useLocation) to avoid router context
  // dependency in static/server-side render tests.
  const handledOauthReturnRef = useRef(false);
  useEffect(() => {
    if (handledOauthReturnRef.current) return;

    const params = new URLSearchParams(window.location.search);
    if (params.get('oauthReturn') !== '1') return;

    handledOauthReturnRef.current = true;
    const restoredDraft = loadEditAgentOAuthDraft();
    const connectionId = params.get('connectionId');
    const status = params.get('status');

    const restored = applyOAuthReturnToForm(form, restoredDraft, connectionId, agentId);
    if (restored) {
      setForm(restored.form);
      setStyle(restored.style);
      setSkillPreset(restored.skillPreset);
      setModelOverrideEnabled(restored.modelOverrideEnabled);
      setModelForm(restored.modelForm);
      setRuntimePolicyOverrides(restored.runtimePolicyOverrides);
    }

    if (status === 'ok') {
      void qc.invalidateQueries({ queryKey: ['connections'] });
      void qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'connections'] });
    }

    clearEditAgentOAuthDraft();

    // Clean up OAuth return params from URL without a full navigation
    params.delete('oauthReturn');
    params.delete('edit');
    params.delete('connectionId');
    params.delete('status');
    params.delete('error');
    const nextSearch = params.toString();
    const nextUrl = nextSearch
      ? `${window.location.pathname}?${nextSearch}`
      : window.location.pathname;
    window.history.replaceState(null, '', nextUrl);
  }, [agentId, qc]);

  // Resolve the effective reasoning levels for display in the model override section.
  // If the agent has an explicit override in runtimePolicyOverrides, use that.
  // Otherwise, show the inherited value from saved AI settings (or fallback defaults).
  const resolvedRuntimeOverrides = runtimePolicyOverrides ?? {};
  const inheritedScoutReasoning = inheritedModelSettings?.scoutReasoning ?? 'none';
  const inheritedJudgeReasoning = inheritedModelSettings?.judgeReasoning ?? 'medium';
  const effectiveScoutReasoning = (resolvedRuntimeOverrides.scoutReasoning as string | null) ?? null;
  const effectiveJudgeReasoning = (resolvedRuntimeOverrides.judgeReasoning as string | null) ?? null;

  function setScoutReasoning(value: string | null) {
    setRuntimePolicyOverrides((prev) => {
      if (value === null || value === '') {
        // Remove from overrides (inherit from settings)
        const next = { ...(prev ?? {}) };
        delete next.scoutReasoning;
        return Object.keys(next).length > 0 ? (next as RuntimePolicyOverrides) : null;
      }
      return { ...(prev ?? {}), scoutReasoning: value };
    });
  }

  function setJudgeReasoning(value: string | null) {
    setRuntimePolicyOverrides((prev) => {
      if (value === null || value === '') {
        const next = { ...(prev ?? {}) };
        delete next.judgeReasoning;
        return Object.keys(next).length > 0 ? (next as RuntimePolicyOverrides) : null;
      }
      return { ...(prev ?? {}), judgeReasoning: value };
    });
  }
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
  const agentGenericConnectionsQuery = useQuery({
    queryKey: ['agents', agentId, 'connections'],
    queryFn: () => agentsApi.getConnections(agentId),
  });
  const allConnectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.list(),
  });
  const docsQuery = useQuery({
    queryKey: ['agent-documents', agentId],
    queryFn: () => agentsApi.listDocuments(agentId),
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
  // Generic connections (all providers including Gmail) for the picker display
  const genericConnections = (allConnectionsQuery.data?.connections ?? []).filter(
    (c) => c.status === 'active',
  );
  // Build a merged view for the connection picker
  const allPickerConnections = useMemo(() => {
    const seen = new Set<string>();
    const merged: Array<{ connectionId: string; provider: string; label: string; status: string; profile?: Record<string, unknown> | null }> = [];
    for (const c of availableConnections) {
      if (!seen.has(c.connectionId)) {
        seen.add(c.connectionId);
        merged.push({ connectionId: c.connectionId, provider: c.provider, label: c.label, status: c.connectionStatus, profile: c.profile });
      }
    }
    for (const c of genericConnections) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        merged.push({ connectionId: c.id, provider: c.provider, label: c.label, status: c.status, profile: c.profile });
      }
    }
    return merged;
  }, [availableConnections, genericConnections]);

  // Auto-select connection when skills change (6.4)
  const prevSkillIdsRef = useRef<string[]>(form.skillIds);
  useEffect(() => {
    if (!allConnectionsQuery.isSuccess && !availableConnectionsQuery.isSuccess) return;
    const prevSkillIds = prevSkillIdsRef.current;
    prevSkillIdsRef.current = form.skillIds;

    setForm((prev) => {
      // Don't override existing selections
      if ((prev.connectionIds ?? []).length > 0) return prev;

      const hasEmailSkill = prev.skillIds.includes('email');
      const hasTradingSkill = prev.skillIds.includes('trading') || prev.skillIds.includes('bot-management');
      const newlyAddedEmail = hasEmailSkill && !prevSkillIds.includes('email');
      const newlyAddedTrading = hasTradingSkill && !prevSkillIds.some((id) => id === 'trading' || id === 'bot-management');

      if (newlyAddedEmail) {
        const emailConn = allPickerConnections.find((c) => c.provider === 'gmail');
        if (emailConn) {
          return { ...prev, connectionIds: [emailConn.connectionId] };
        }
      }

      if (newlyAddedTrading) {
        const tradingConns = allPickerConnections.filter((c) => venueTypeMap[c.provider] !== undefined);
        if (tradingConns.length === 1) {
          return { ...prev, connectionIds: [tradingConns[0]!.connectionId] };
        }
      }

      return prev;
    });
  }, [form.skillIds, allConnectionsQuery.isSuccess, availableConnectionsQuery.isSuccess, allPickerConnections]);

  // Initialize connectionIds from the agent's current connections (both trading + generic)
  useEffect(() => {
    const tradingReady = agentConnectionsQuery.isSuccess;
    const genericReady = agentGenericConnectionsQuery.isSuccess;
    if (!tradingReady && !genericReady) return;

    const activeIds = new Set<string>();
    // Trading connections
    for (const c of (agentConnectionsQuery.data?.connections ?? [])) {
      if (c.grantStatus === 'active') activeIds.add(c.connectionId);
    }
    // Generic connections (includes non-trading like Gmail)
    for (const c of (agentGenericConnectionsQuery.data?.connections ?? [])) {
      if (c.grantStatus === 'active' || c.status === 'active') activeIds.add(c.connectionId);
    }

    const activeIdsArr = [...activeIds];
    setForm((prev) => {
      const prevIds = prev.connectionIds ?? [];
      if (prevIds.length === activeIdsArr.length && prevIds.every((id) => activeIdsArr.includes(id))) {
        return prev;
      }
      return { ...prev, connectionIds: activeIdsArr };
    });
  }, [agentConnectionsQuery.isSuccess, agentConnectionsQuery.data?.connections, agentGenericConnectionsQuery.isSuccess, agentGenericConnectionsQuery.data?.connections]);

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
  const showIntelligence = form.capabilityMode === 'intelligence' || form.capabilityMode === 'hybrid';
  const requiresTradingSetup = skillPreset === 'trading' || skillPreset === 'direct-trading' || skillPreset === 'trading-assistant' || hasCapabilityFamily(selectedSkills, 'trading');
  // Short-circuit to false when a non-trading preset (Custom or
  // Personal Assistant) is selected — no trading skills are inferred
  // and we don't want the fallback to currentHasTradingCapability keeping
  // the trading tab visible while the skills query is still loading.
  const hasTradingCapability = (skillPreset === 'trading' || skillPreset === 'direct-trading' || skillPreset === 'trading-assistant' || hasCapabilityFamily(selectedSkills, 'trading')) && showIntelligence && (skillsQuery.isSuccess
    ? hasCapabilityFamily(selectedSkills, 'trading')
    : currentHasTradingCapability);
  // Field-value fallback: show trading controls whenever stored values are present,
  // including agents that have trading values but no explicit trading skills (custom
  // preset derived from empty skillIds). When the user explicitly picks a non-trading
  // preset (Custom or Personal Assistant), the preset change handler clears all
  // values synchronously, so this naturally becomes false without needing a
  // skillPreset gate.
  const showTradingControls = requiresTradingSetup || hasTradingCapability
    || Boolean(form.capital.trim() || form.dailyMaxLossPct.trim() || form.maxDrawdownPct.trim() || form.maxSlippageBps.trim() || form.maxOpenPositions.trim() || form.maxPositionSizePct.trim() || form.stopLossPct.trim() || form.stopLossCooldownSecs.trim());
  const validationConstraints: ValidationConstraints = {
    maxOpenPositions: riskDefaultsQuery.data?.maxOpenPositions ?? 10,
    maxPositionSizePct: riskDefaultsQuery.data?.maxPositionSizePct ?? 100,
    stopLossPct: riskDefaultsQuery.data?.stopLossPct ?? 100,
  };

  // Sync capabilityMode from technicalPreFilterEnabled toggle + trading skill presence
  useEffect(() => {
    setForm((state) => {
      const resolvedSkills = selectableSkills.filter((s) => state.skillIds.includes(s.id));
      const syntheticTradingSkill =
        skillPreset === 'trading' || skillPreset === 'direct-trading' || skillPreset === 'trading-assistant' ? [{ capabilityFamilies: ['trading'] }] : [];
      const effectiveSkills =
        resolvedSkills.length > 0 ? resolvedSkills : syntheticTradingSkill;
      const hasTradingSkill = hasCapabilityFamily(effectiveSkills, 'trading');
      const derived: CapabilityMode = state.technicalPreFilterEnabled && hasTradingSkill ? 'hybrid' : 'intelligence';
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
    mutationFn: async () => {
      const skillIds = Array.from(new Set([...preservedSkillIds, ...form.skillIds.filter((skillId) => selectableSkillIds.has(skillId))]));
      const activeConnection = agentConnectionsQuery.data?.connections
        ?.find(c => c.grantStatus === 'active' && c.connectionStatus === 'active');
      const connectionVenue = activeConnection?.provider ?? '';
      const connectionVenueType = (venueTypeMap[connectionVenue] ?? '') as '' | 'orderbook' | 'swap';
      const hasStrategyPreset = form.strategyPreset && form.strategyPreset !== 'custom';
      const technicalPayload = (!hasStrategyPreset && form.technicalPreFilterEnabled)
        ? technicalFormStateToPayload(form.technicalConfig, connectionVenue || undefined, connectionVenueType || undefined)
        : null;
      const agent = await agentsApi.update(agentId, buildUpdateAgentPayload({
        name: form.name,
        prompt: form.goal,
        capabilityMode: form.capabilityMode,
        hybridMode: form.hybridMode ?? 'scanner_gated',
        technicalPreFilterEnabled: form.technicalPreFilterEnabled,
        technical: technicalPayload,
        strategyPreset: hasStrategyPreset
          ? form.strategyPreset
          : undefined,
        skillIds,
        hasBotManagementSkill,
        executionMode: form.executionMode,
        hasTradingCapability,
        connectionIds: form.connectionIds,
        telegramChatId: form.telegramChatId,
        emailDelivery: form.emailDelivery,
        costPreset: form.costPreset,
        dailySpendBudgetUsd: form.dailySpendBudgetUsd,
        dailyMaxLossPct: form.dailyMaxLossPct,
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
        subscribedSources: form.subscribedSources,
        platformAssessmentEnabled: form.platformAssessmentEnabled,
        platformAssessmentReviewIntervalHours: form.platformAssessmentReviewIntervalHours,
        skillPresetId: skillPreset !== 'custom' ? skillPreset : undefined,
        authorizationMode: form.authorizationMode,
      }));

      if (form.pendingFiles.length > 0) {
        for (const file of form.pendingFiles) {
          try {
            await agentsApi.uploadDocument(agentId, file);
          } catch (err) {
            console.warn('Document upload failed:', file.name, err);
          }
        }
      }

      return agent;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', agentId] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['agent-documents', agentId] });
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

    // Block save when removing the last connection from a live or venue-backed
    // (shadow) agent without explicitly switching execution mode.
    const hasExistingActiveConnections = (agentConnectionsQuery.data?.connections ?? [])
      .some((c) => c.grantStatus === 'active');
    const connectionError = validateEditAgentConnections({
      storedExecutionMode: initialData.executionMode,
      formExecutionMode: form.executionMode,
      connectionIds: form.connectionIds ?? [],
      hasExistingActiveConnections,
      executionModeWasTouched: executionModeTouchedRef.current,
    });
    if (connectionError) {
      setFormErrors({ ...result.errors, connectionIds: connectionError });
      return;
    }

    mutation.mutate();
  };

  return (
    <Modal title={intl.formatMessage({ id: 'agents.edit.title' })} onClose={onClose} closeOnBackdropClick={false}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <form id="edit-agent-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Skill Preset — same label as create agent form */}
          <div style={{ marginBottom: '20px' }}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.create.skillPreset' })}</FieldLabel>
            <select
              value={skillPreset}
              onChange={(e) => {
                const preset = e.target.value as SkillPresetId;
                setSkillPreset(preset);
                setForm((prev) => ({
                  ...prev,
                  skillIds: resolveSkillPresetSkillIds(preset, prev.skillIds),
                  // authorizationMode defaults to direct for all presets
                  authorizationMode: 'direct' as const,
                  // Clear trading values when switching to a non-trading preset
                  // so stale values don't keep trading UI visible via the
                  // field-value fallback in showTradingControls.
                  ...(preset !== 'trading' ? {
                    executionMode: '' as const,
                    capital: '',
                    dailyMaxLossPct: '',
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
            <div style={{ marginBottom: '20px' }}>
              <SkillPicker
                skills={selectableSkills}
                selectedSkillIds={form.skillIds}
                onChange={(skillIds) => setForm((prev) => ({ ...prev, skillIds }))}
                loading={skillsQuery.isLoading}
                errorMessage={skillsQuery.error instanceof Error ? skillsQuery.error.message : null}
              />
            </div>
          )}

          {/* Prompt + files + style — unified block */}
          <div style={{ marginBottom: '8px' }}>
          <PromptInputBlock
            dataField="goal"
            goal={form.goal}
            onGoalChange={(goal) => {
              clearFieldError('goal');
              setForm((prev) => ({ ...prev, goal }));
            }}
            onGoalBlur={() => validateFieldOnBlur('goal')}
            goalPlaceholder={intl.formatMessage({ id: resolveGoalPlaceholderKey(skillPreset) })}
            goalLabel={intl.formatMessage({ id: 'agents.edit.objective' })}
            goalError={formErrors.goal}
            required
            pendingFiles={form.pendingFiles}
            onPendingFilesChange={(pendingFiles) => setForm((prev) => ({ ...prev, pendingFiles }))}
            existingDocs={docsQuery.data?.documents}
            onDeleteExistingDoc={async (docId) => {
              try {
                await agentsApi.deleteDocument(agentId, docId);
                await docsQuery.refetch();
              } catch (err) {
                console.warn('Document delete failed:', err);
              }
            }}
            style={style}
            onStyleChange={(nextStyle) => {
              const defaults = resolveStyleDefaults(nextStyle);
              setTickIntervalTouched(true);
              setStyle(nextStyle);
              const tradingSources = ['watch_threshold', 'discovery_delta', 'regime_change'];
              setForm((prev) => {
                const styleSources = prev.technicalPreFilterEnabled
                  ? [...tradingSources, 'scanner']
                  : tradingSources;
                return {
                  ...prev,
                  costPreset: defaults.costPreset,
                  tickIntervalMins: defaults.tickIntervalMins,
                  dailySpendBudgetUsd: defaults.dailySpendBudgetUsd,
                  subscribedSources: styleSources,
                  ...(policyManuallySetRef.current
                    ? {}
                    : { openPositionEscalationToJudgePolicy: defaults.openPositionEscalationToJudgePolicy }),
                };
              });
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

          {/* Style summary */}
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '0' }}>
            {formatStyleSummary(
              style,
              intl.formatMessage({ id: STYLE_LABEL_KEYS[style] }),
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
            accountEmail={meQuery.data?.email ?? null}
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
            subscribedSources={form.subscribedSources}
            onSubscribedSourcesChange={(sources) => setForm((prev) => ({ ...prev, subscribedSources: sources }))}
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <FieldLabel>{intl.formatMessage({ id: 'agents.create.connections' })}</FieldLabel>
                {(availableConnectionsQuery.isLoading || allConnectionsQuery.isLoading) ? (
                  <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.create.loadingConnections' })}</div>
                ) : allPickerConnections.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                      {intl.formatMessage({ id: 'agents.create.noConnections' })}
                    </div>
                    <div>
                      <Button variant="secondary" size="sm" onClick={() => setShowAddConnection(true)}>
                        {intl.formatMessage({ id: 'agents.create.addConnection' })}
                      </Button>
                    </div>
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
                      {/* Trading connections group */}
                      {allPickerConnections.some((c) => venueTypeMap[c.provider] !== undefined) && (
                        <optgroup label={intl.formatMessage({ id: 'agents.create.connections.trading' })}>
                          {allPickerConnections
                            .filter((c) => venueTypeMap[c.provider] !== undefined)
                            .map((connection) => (
                              <option key={connection.connectionId} value={connection.connectionId}>
                                {connection.label} ({connection.provider})
                              </option>
                            ))}
                        </optgroup>
                      )}
                      {/* Non-trading connections group */}
                      {allPickerConnections.some((c) => venueTypeMap[c.provider] === undefined) && (
                        <optgroup label={intl.formatMessage({ id: 'agents.create.connections.other' })}>
                          {allPickerConnections
                            .filter((c) => venueTypeMap[c.provider] === undefined)
                            .map((connection) => (
                              <option key={connection.connectionId} value={connection.connectionId}>
                                {connection.label} ({connection.provider})
                              </option>
                            ))}
                        </optgroup>
                      )}
                    </select>
                    {(form.connectionIds ?? []).length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {(form.connectionIds ?? []).map((id) => {
                          const conn = allPickerConnections.find((c) => c.connectionId === id);
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
                    <button
                      type="button"
                      onClick={() => setShowAddConnection(true)}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '4px 0',
                        fontSize: '12px',
                        color: 'var(--color-brand)',
                        textAlign: 'left',
                      }}
                    >
                      {intl.formatMessage({ id: 'agents.create.addConnection' })}
                    </button>
                  </>
                )}
              </div>
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

                      {/* Reasoning level dropdowns */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                        <div>
                          <FieldLabel>{intl.formatMessage({ id: 'agents.edit.models.reasoning.scoutLabel' })}</FieldLabel>
                          <select
                            aria-label={intl.formatMessage({ id: 'agents.edit.models.reasoning.scoutLabel' })}
                            value={effectiveScoutReasoning ?? ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              setScoutReasoning(val === '' ? null : val);
                            }}
                            style={{ ...inputStyle, cursor: 'pointer', width: '100%' }}
                          >
                            <option value="">
                              {intl.formatMessage({ id: 'agents.edit.models.reasoning.inherit' }, { value: inheritedScoutReasoning })}
                            </option>
                            {getAllowedReasoningLevels(RUNTIME_POLICY_CEILINGS.scoutReasoningMax).map((level) => (
                              <option key={level} value={level}>{intl.formatMessage({ id: `aiModels.reasoning.${level}` })}</option>
                            ))}
                          </select>
                          <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                            {intl.formatMessage({ id: 'agents.edit.models.reasoning.scoutHelp' })}
                          </div>
                        </div>
                        <div>
                          <FieldLabel>{intl.formatMessage({ id: 'agents.edit.models.reasoning.judgeLabel' })}</FieldLabel>
                          <select
                            aria-label={intl.formatMessage({ id: 'agents.edit.models.reasoning.judgeLabel' })}
                            value={effectiveJudgeReasoning ?? ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              setJudgeReasoning(val === '' ? null : val);
                            }}
                            style={{ ...inputStyle, cursor: 'pointer', width: '100%' }}
                          >
                            <option value="">
                              {intl.formatMessage({ id: 'agents.edit.models.reasoning.inherit' }, { value: inheritedJudgeReasoning })}
                            </option>
                            <option value="none">{intl.formatMessage({ id: 'aiModels.reasoning.none' })}</option>
                            <option value="low">{intl.formatMessage({ id: 'aiModels.reasoning.low' })}</option>
                            <option value="medium">{intl.formatMessage({ id: 'aiModels.reasoning.medium' })}</option>
                            <option value="high">{intl.formatMessage({ id: 'aiModels.reasoning.high' })}</option>
                          </select>
                          <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                            {intl.formatMessage({ id: 'agents.edit.models.reasoning.judgeHelp' })}
                          </div>
                        </div>
                      </div>

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
                <div>
                  {(requiresTradingSetup || hasTradingCapability) && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '48px' }}>
                      <FieldLabel>{intl.formatMessage({ id: 'agents.executionMode.label' })}</FieldLabel>
                      <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.executionMode} onChange={(e) => { executionModeTouchedRef.current = true; setForm((prev) => ({ ...prev, executionMode: e.target.value })); }}>
                        <option value="">{intl.formatMessage({ id: 'agents.edit.executionModeUnset' })}</option>
                        <option value="test">{intl.formatMessage({ id: 'agents.create.executionMode.test' })}</option>
                        <option value="live">{intl.formatMessage({ id: 'agents.create.executionMode.live' })}</option>
                      </select>
                      <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                        {intl.formatMessage({ id: 'agents.edit.executionModeHelp' }, { mode: formatExecutionMode(form.executionMode, intl) })}
                      </div>
                    </div>
                  )}

                  {/* Trade Authorization */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '48px' }}>
                    <FieldLabel>{intl.formatMessage({ id: 'agents.authorizationMode.label' })}</FieldLabel>
                    <select
                      style={{ ...inputStyle, cursor: 'pointer' }}
                      value={form.authorizationMode}
                      onChange={(e) => setForm((prev) => ({ ...prev, authorizationMode: e.target.value as 'direct' | 'approval_required' }))}
                    >
                      <option value="direct">{intl.formatMessage({ id: 'agents.authorizationMode.direct' })}</option>
                      <option value="approval_required">{intl.formatMessage({ id: 'agents.authorizationMode.approvalRequired' })}</option>
                    </select>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                      {form.authorizationMode === 'direct'
                        ? intl.formatMessage({ id: 'agents.authorizationMode.directHelp' })
                        : intl.formatMessage({ id: 'agents.authorizationMode.approvalRequiredHelp' })}
                    </div>
                  </div>

                  <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>
                    {intl.formatMessage({ id: 'agents.create.tradingControls.title' })}
                  </div>
                  <TradingGuardrailsFields
                    value={{
                      dailyMaxLossPct: form.dailyMaxLossPct,
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
            advancedActionsSlot={
              <>
                <Button variant="ghost" onClick={onClose} type="button">{intl.formatMessage({ id: 'common.cancel' })}</Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={mutation.isPending
                    || agentConnectionsQuery.isLoading
                    || !form.name.trim()
                    || (showIntelligence && !form.goal.trim())
                    || tickIntervalError != null
                    || (modelOverrideEnabled && (!modelForm.provider || !modelForm.lightModel || !modelForm.heavyModel))}
                >
                  {mutation.isPending ? intl.formatMessage({ id: 'agents.edit.saving' }) : intl.formatMessage({ id: 'common.saveChanges' })}
                </Button>
              </>
            }
            onAdvancedToggle={setAdvancedOpen}
          />

        </form>

        {mutation.isError && <ErrorBanner message={localizeApiError(intl, mutation.error, 'common.errorTitle')} />}

        {advancedOpen && (
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} type="button">{intl.formatMessage({ id: 'common.cancel' })}</Button>
          <Button
            variant="primary"
            type="submit"
            form="edit-agent-form"
            disabled={mutation.isPending
              || agentConnectionsQuery.isLoading
              || !form.name.trim()
              || (showIntelligence && !form.goal.trim())
              || tickIntervalError != null
              || (modelOverrideEnabled && (!modelForm.provider || !modelForm.lightModel || !modelForm.heavyModel))}
          >
            {mutation.isPending ? intl.formatMessage({ id: 'agents.edit.saving' }) : intl.formatMessage({ id: 'common.saveChanges' })}
          </Button>
        </div>
        )}
      </div>

      {showAddConnection && (
        <ProviderSetupForm
          onClose={() => setShowAddConnection(false)}
          onSuccess={(result) => {
            void qc.invalidateQueries({ queryKey: ['connections'] });
            void qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'connections'] });
            setForm((prev) => ({
              ...prev,
              connectionIds: result.connection?.id
                ? Array.from(new Set([...(prev.connectionIds ?? []), result.connection.id]))
                : prev.connectionIds,
            }));
            setShowAddConnection(false);
          }}
          oauthReturnTo={`/agents/${agentId}?edit=1&oauthReturn=1`}
          onBeforeOAuthRedirect={() => {
            const { pendingFiles: _, ...serializableForm } = form;
            saveEditAgentOAuthDraft({
              agentId,
              form: serializableForm,
              style,
              skillPreset,
              modelOverrideEnabled,
              modelForm,
              runtimePolicyOverrides,
            });
          }}
        />
      )}
    </Modal>
  );
}
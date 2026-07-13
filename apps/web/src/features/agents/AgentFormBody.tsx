import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { FieldLabel, SectionLabel, inputStyle } from '../../lib/ui.js';
import { bots as botsApi, type Skill } from '../../lib/api-client.js';
import type { AgentFormState } from './agent-form-state.js';
import { TechnicalConfigSection } from './TechnicalConfigSection.js';
import { StrategyPresetSelector } from '../../lib/StrategyPresetSelector.js';
import { AdvancedSettingsSection } from './AdvancedSettingsSection.js';
import { AgentControlsSection } from './AgentControlsSection.js';
import { WakeSourceSection, TRADING_WAKE_SOURCES } from './WakeSourceSection.js';
import { validateCreateAgentForm, type ValidationConstraints } from './form-validation.js';

// ---------------------------------------------------------------------------
// ADVANCED_FIELD_TAB — maps validated field names to Advanced Settings tab index
// ---------------------------------------------------------------------------

/**
 * Strategy preset keys that are valid for agents.
 * DCA is intentionally excluded — it is a bot-only strategy and the API
 * rejects it for agent preset application (preset_not_supported_for_agent).
 */
const AGENT_STRATEGY_PRESET_KEYS = [
  'momentum',
  'momentum-position',
  'range',
  'swing',
  'scalper',
  'contrarian',
] as const;

// ---------------------------------------------------------------------------
// ADVANCED_FIELD_TAB — maps validated field names to Advanced Settings tab index
// ---------------------------------------------------------------------------

/**
 * Maps validated field names to the Advanced Settings tab index that contains them.
 * Update this whenever a field moves between tabs or a new validated field is added.
 *   0 = AI
 *   1 = Trading Setup
 *   2 = Strategy
 */
export const ADVANCED_FIELD_TAB: Record<string, number> = {
  // AI
  tickIntervalMins: 0,
  dailySpendBudgetUsd: 0,
  // Trading Setup
  executionMode: 1,
  venue: 1,
  dailyLossLimit: 1,
  maxSlippageBps: 1,
  maxOpenPositions: 1,
  maxPositionSizePct: 1,
  stopLossPct: 1,
  stopLossCooldownSecs: 1,
  openPositionEscalationToJudgePolicy: 1,
  // Strategy
};

/**
 * Map an agent personality style to the strategy preset tier the backend uses.
 * Mirrors `agentStyleToPresetStyle()` in @herobids/domain — kept in sync so the
 * UI fetches the same tier the API will resolve on write.
 */
function agentStyleToPresetTier(style: string | null | undefined): 'economy' | 'standard' | 'premium' {
  switch (style) {
    case 'careful':
      return 'economy';
    case 'bold':
      return 'premium';
    default:
      return 'standard';
  }
}

// ---------------------------------------------------------------------------
// AgentFormBodyProps
// ---------------------------------------------------------------------------

export interface AgentFormBodyProps {
  // Core form state
  value: AgentFormState;
  onChange: (patch: Partial<AgentFormState>) => void;

  // Display flags (computed by caller)
  showIntelligence: boolean;
  showTradingControls: boolean;
  requiresTradingSetup: boolean;
  isAdmin: boolean;

  /** Agent personality style — drives the derived preset tier (economy/standard/premium). */
  agentStyle?: string | null;

  // Skills
  selectableSkills: Skill[];
  skillsLoading: boolean;
  skillsError: string | null;

  // Validation
  formErrors: Record<string, string>;
  onClearFieldError: (field: string) => void;
  onBlurField: (field: string) => void;
  validationConstraints: ValidationConstraints;

  // Tick interval
  tickIntervalError: string | null;
  tickIntervalNotice?: string | null;
  effectiveTickIntervalMs?: number | null;

  // Slots (caller injects shell-specific chrome)
  modelSlot: React.ReactNode;
  connectionSlot?: React.ReactNode;
  tradingSetupSlot?: React.ReactNode;
  computeBudgetSlot?: React.ReactNode;
  nameAutoHint?: React.ReactNode;
  /** Cancel/Review (or Save) buttons rendered at the top of Advanced Settings. */
  advancedActionsSlot?: React.ReactNode;
  /** Called when the Advanced Settings section is expanded or collapsed. */
  onAdvancedToggle?: (open: boolean) => void;

  /** Account email shown read-only next to the email delivery control. */
  accountEmail?: string | null;

  /** Whether to show the document upload section. Default true. */
  showDocumentUpload?: boolean;

  // Wake source subscriptions
  subscribedSources: string[];
  onSubscribedSourcesChange: (sources: string[]) => void;
}

// ---------------------------------------------------------------------------
// AgentFormBody
// ---------------------------------------------------------------------------

export function AgentFormBody(props: AgentFormBodyProps) {
  const intl = useIntl();
  const [advancedExpandSeq, setAdvancedExpandSeq] = useState(0);
  const [advancedErrorTabIdx, setAdvancedErrorTabIdx] = useState(1);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const hasBotManagementSkill = props.value.skillIds.includes('bot-management');

  // Fetch style-based strategy presets from the backend (single source of truth
  // for preset identity, labels, and descriptions). The tier is derived from the
  // agent's style so the UI previews exactly what the API will resolve on write.
  const presetTier = agentStyleToPresetTier(props.agentStyle);
  const presetsQuery = useQuery({
    queryKey: ['strategy-presets', presetTier],
    queryFn: () => botsApi.getPresets(presetTier),
    enabled: props.value.technicalPreFilterEnabled,
    staleTime: 5 * 60 * 1000,
  });

  // Filter to agent-compatible presets (excludes DCA and any future bot-only strategies)
  const agentPresets = (presetsQuery.data?.presets ?? []).filter((p) =>
    (AGENT_STRATEGY_PRESET_KEYS as readonly string[]).includes(p.key),
  );

  // ---- internal helpers ----

  function bumpAdvancedExpand(errorKeys: string[]) {
    const advancedKey = errorKeys.find((k) => k in ADVANCED_FIELD_TAB);
    if (advancedKey !== undefined) {
      setAdvancedErrorTabIdx(ADVANCED_FIELD_TAB[advancedKey]!);
      setAdvancedExpandSeq((s) => s + 1);
    }
  }

  // Auto-expand Advanced Settings whenever the parent pushes errors for fields
  // that live inside it (e.g. executionMode, maxOpenPositions). This covers
  // the "Review →" button path where the parent sets formErrors directly.
  useEffect(() => {
    const advancedErrorKeys = Object.keys(props.formErrors).filter((k) => k in ADVANCED_FIELD_TAB);
    if (advancedErrorKeys.length > 0) {
      bumpAdvancedExpand(advancedErrorKeys);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.formErrors]);

  function handleFieldBlur(fieldName: string) {
    // Derive venue for validation: live/shadow need a non-empty venue
    const venue =
      props.value.executionMode === 'live' || props.value.executionMode === 'shadow'
        ? 'connected'
        : '';

    const result = validateCreateAgentForm(
      {
        name: props.value.name,
        goal: props.value.goal,
        capabilityMode: props.value.capabilityMode,
        capital: props.value.capital,
        tickIntervalMins: props.value.tickIntervalMins,
        maxOpenPositions: props.value.maxOpenPositions,
        maxPositionSizePct: props.value.maxPositionSizePct,
        stopLossPct: props.value.stopLossPct,
        venue,
        venueType: '',
        executionMode: props.value.executionMode,
        requiresTradingSetup: props.requiresTradingSetup,
      },
      props.validationConstraints,
    );

    // Notify parent to update its error state
    props.onBlurField(fieldName);

    // Auto-expand advanced settings if error is in a non-default tab
    if (result.errors[fieldName] && fieldName in ADVANCED_FIELD_TAB) {
      bumpAdvancedExpand([fieldName]);
    }
  }

  // ---- styles ----

  const fieldGap: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    marginBottom: '20px',
  };

  const errorStyle: React.CSSProperties = {
    color: 'var(--color-danger)',
    fontSize: '12px',
    marginTop: '2px',
  };

  const helperStyle: React.CSSProperties = {
    marginTop: '2px',
    fontSize: '12px',
    color: 'var(--color-text-muted)',
    lineHeight: '1.5',
  };

  // ---- render ----

  return (
    <>
      {/* Capital — only when trading setup is required */}
      {props.showTradingControls && props.requiresTradingSetup && (
        <div data-field="capital" style={fieldGap}>
          <FieldLabel>
            {intl.formatMessage({ id: 'agents.controls.capital' })}
          </FieldLabel>
          <input
            style={inputStyle}
            value={props.value.capital}
            onChange={(e) => {
              props.onClearFieldError('capital');
              props.onChange({ capital: e.target.value });
            }}
            onBlur={() => handleFieldBlur('capital')}
            placeholder={intl.formatMessage({ id: 'common.unlimited' })}
          />
          {props.formErrors.capital && (
            <div style={errorStyle}>{props.formErrors.capital}</div>
          )}
          <div style={helperStyle}>
            {intl.formatMessage({ id: 'agents.controls.capital.help' })}
          </div>
        </div>
      )}

      {/* Platform link — only when trading setup is required */}
      {props.showTradingControls && props.requiresTradingSetup && (
        <div style={fieldGap}>{props.connectionSlot}</div>
      )}

      {/* Telegram Chat ID — always visible */}
      <div style={fieldGap}>
        <FieldLabel>
          {intl.formatMessage({ id: 'agents.create.telegramChatId' })}
        </FieldLabel>
        <input
          style={inputStyle}
          value={props.value.telegramChatId}
          onChange={(e) => props.onChange({ telegramChatId: e.target.value })}
          placeholder={intl.formatMessage({ id: 'agents.create.telegramChatId.placeholder' })}
        />
      </div>

      {/* Name + auto-hint */}
      <div data-field="name" style={fieldGap}>
        <FieldLabel>
          {intl.formatMessage({ id: 'agents.create.name' })}
        </FieldLabel>
        <input
          style={inputStyle}
          type="text"
          value={props.value.name}
          onChange={(e) => {
            props.onClearFieldError('name');
            props.onChange({ name: e.target.value });
          }}
          onBlur={() => handleFieldBlur('name')}
          placeholder={intl.formatMessage({ id: 'agents.create.namePlaceholder' })}
          maxLength={100}
          required
        />
        {props.formErrors.name && (
          <div style={errorStyle}>{props.formErrors.name}</div>
        )}
        {props.nameAutoHint}
      </div>

      {/* Actions at top of Advanced Settings.
           Always visible — when collapsed these are the only buttons; when expanded
           the bottom duplicates are also shown. */}
      {props.advancedActionsSlot && (
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', margin: '24px 0 16px' }}>
          {props.advancedActionsSlot}
        </div>
      )}

      {/* Advanced Settings (tabs) */}
      <AdvancedSettingsSection
        expandSeq={advancedExpandSeq}
        errorTabIdx={advancedErrorTabIdx}
        formErrors={props.formErrors}
        fieldTabMap={ADVANCED_FIELD_TAB}
        onToggle={(open) => {
          setAdvancedOpen(open);
          props.onAdvancedToggle?.(open);
        }}
        aiConfig={
          <div style={{ display: 'flex', flexDirection: 'column', gap: '48px' }}>
            {props.modelSlot}
            <AgentControlsSection
              value={{
                costPreset: props.value.costPreset,
                dailySpendBudgetUsd: props.value.dailySpendBudgetUsd,
                tickIntervalMins: props.value.tickIntervalMins,
                dailyLossLimit: props.value.dailyLossLimit,
                maxSlippageBps: props.value.maxSlippageBps,
                maxOpenPositions: props.value.maxOpenPositions,
                maxPositionSizePct: props.value.maxPositionSizePct,
                stopLossPct: props.value.stopLossPct,
                stopLossCooldownSecs: props.value.stopLossCooldownSecs,
              }}
              onChange={(patch) => {
                // Map AgentControlsFormValue fields to AgentFormState
                const agentPatch: Partial<AgentFormState> = {};
                if ('costPreset' in patch && patch.costPreset !== undefined) agentPatch.costPreset = patch.costPreset;
                if ('dailySpendBudgetUsd' in patch && patch.dailySpendBudgetUsd !== undefined) agentPatch.dailySpendBudgetUsd = patch.dailySpendBudgetUsd;
                if ('tickIntervalMins' in patch && patch.tickIntervalMins !== undefined) agentPatch.tickIntervalMins = patch.tickIntervalMins;
                if ('dailyLossLimit' in patch && patch.dailyLossLimit !== undefined) agentPatch.dailyLossLimit = patch.dailyLossLimit;
                if ('maxSlippageBps' in patch && patch.maxSlippageBps !== undefined) agentPatch.maxSlippageBps = patch.maxSlippageBps;
                if ('maxOpenPositions' in patch && patch.maxOpenPositions !== undefined) agentPatch.maxOpenPositions = patch.maxOpenPositions;
                if ('maxPositionSizePct' in patch && patch.maxPositionSizePct !== undefined) agentPatch.maxPositionSizePct = patch.maxPositionSizePct;
                if ('stopLossPct' in patch && patch.stopLossPct !== undefined) agentPatch.stopLossPct = patch.stopLossPct;
                if ('stopLossCooldownSecs' in patch && patch.stopLossCooldownSecs !== undefined) agentPatch.stopLossCooldownSecs = patch.stopLossCooldownSecs;
                props.onChange(agentPatch);
              }}
              showBotControls={hasBotManagementSkill}
              tickIntervalError={props.tickIntervalError}
              tickIntervalNotice={props.tickIntervalNotice}
              effectiveTickIntervalMs={props.effectiveTickIntervalMs}
              fieldErrors={props.formErrors}
              onClearFieldError={props.onClearFieldError}
              onBlurField={handleFieldBlur}
            />
            {props.computeBudgetSlot}

            {/* Email delivery — tri-state override */}
            <div>
              <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '6px' }}>
                {intl.formatMessage({ id: 'agents.create.emailDelivery' })}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '8px' }}>
                {props.accountEmail
                  ? `${intl.formatMessage({ id: 'agents.create.emailDelivery.help' })} — ${props.accountEmail}`
                  : intl.formatMessage({ id: 'agents.create.emailDelivery.helpNoEmail' })}
              </div>
              <select
                style={{ ...inputStyle, cursor: 'pointer' }}
                value={props.value.emailDelivery}
                onChange={(e) => props.onChange({ emailDelivery: e.target.value as 'inherit' | 'allow' | 'disable' })}
              >
                <option value="inherit">{intl.formatMessage({ id: 'agents.create.emailDelivery.inherit' })}</option>
                <option value="allow">{intl.formatMessage({ id: 'agents.create.emailDelivery.allow' })}</option>
                <option value="disable">{intl.formatMessage({ id: 'agents.create.emailDelivery.disable' })}</option>
              </select>
            </div>
          </div>
        }
        tradingSetup={
          props.requiresTradingSetup ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '48px' }}>
              {props.tradingSetupSlot}
            </div>
          ) : props.tradingSetupSlot
        }
        strategy={
          props.requiresTradingSetup ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '48px' }}>
              {/* Filter Trades — 3-way selector replacing pre-filter toggle + hybrid mode */}
              <div>
                <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '4px', color: 'var(--color-text-primary)' }}>
                  Filter Trades
                </div>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '12px', lineHeight: '1.4' }}>
                  Reduce cost by filtering trade candidates before AI agent sees them
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {([
                    { value: 'off' as const, label: 'Off', description: 'No pre-filtering. Wake sources trigger the agent directly.' },
                    { value: 'mixed' as const, label: 'Mixed', description: 'Scanner + wake sources. Both may trigger the agent.' },
                    { value: 'scanner_gated' as const, label: 'Scanner only', description: 'Only scanner signals trigger the agent.' },
                  ]).map((option) => {
                    const filterMode: 'off' | 'mixed' | 'scanner_gated' =
                      !props.value.technicalPreFilterEnabled ? 'off'
                      : props.value.hybridMode === 'mixed' ? 'mixed'
                      : 'scanner_gated';
                    const active = filterMode === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          if (option.value === 'off') {
                            props.onChange({ capabilityMode: 'intelligence', hybridMode: undefined, technicalPreFilterEnabled: false });
                            props.onSubscribedSourcesChange(props.subscribedSources.filter(s => s !== 'scanner'));
                          } else if (option.value === 'mixed') {
                            props.onChange({ capabilityMode: 'hybrid', hybridMode: 'mixed', technicalPreFilterEnabled: true });
                            if (!props.subscribedSources.includes('scanner')) {
                              props.onSubscribedSourcesChange([...props.subscribedSources, 'scanner']);
                            }
                          } else {
                            props.onChange({ capabilityMode: 'hybrid', hybridMode: 'scanner_gated', technicalPreFilterEnabled: true });
                          }
                        }}
                        style={{
                          flex: 1,
                          padding: '10px 12px',
                          borderRadius: '8px',
                          border: `1.5px solid ${active ? 'var(--color-brand)' : 'var(--color-border)'}`,
                          background: active ? 'var(--color-brand-subtle, rgba(99,102,241,0.06))' : 'var(--color-surface-1)',
                          cursor: 'pointer',
                          textAlign: 'left' as const,
                          transition: 'border-color 0.12s',
                        }}
                      >
                        <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--color-text-primary)', marginBottom: '4px' }}>
                          {option.label}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', lineHeight: '1.4' }}>
                          {option.description}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Wake sources — hidden only when scanner_gated (scanner is the sole trading wake source) */}
              {(props.value.capabilityMode !== 'hybrid' || props.value.hybridMode !== 'scanner_gated') && (
                <WakeSourceSection
                  sources={TRADING_WAKE_SOURCES}
                  selected={props.subscribedSources}
                  onChange={(sources) => {
                  // DESIGN DECISION: Reminders are always-on for ALL agents.
                  if (sources.length > 0 && !sources.includes('reminder')) {
                    props.onSubscribedSourcesChange([...sources, 'reminder']);
                  } else {
                    props.onSubscribedSourcesChange(sources);
                  }
                }}
              />
              )}

              {/* Technical Config — hidden when filter mode is off */}
              <div style={{ display: props.value.technicalPreFilterEnabled ? 'block' : 'none' }}>
                <StrategyPresetSelector
                  value={props.value.strategyPreset}
                  onChange={(key) => props.onChange({ strategyPreset: key })}
                  presets={agentPresets}
                  loading={presetsQuery.isLoading}
                />

                {/* Detailed technical editor — only shown in custom mode.
                    Manual edits keep the preset marked 'custom' (custom-on-divergence:
                    once the user is in the raw editor, the config is no longer preset-managed). */}
                {(!props.value.strategyPreset || props.value.strategyPreset === 'custom') && (
                  <>
                    <div
                      style={{
                        fontSize: '13px',
                        fontWeight: '600',
                        marginBottom: '12px',
                        marginTop: '48px',
                      }}
                    >
                      {intl.formatMessage({ id: 'agents.technical.title' })}
                    </div>
                    <TechnicalConfigSection
                      value={props.value.technicalConfig}
                      onChange={(technicalConfig) =>
                        // Any manual edit to raw technical config marks the config as custom,
                        // ensuring we never silently submit a stale preset alongside diverged params.
                        props.onChange({ technicalConfig, strategyPreset: 'custom' })
                      }
                      showErrors={Object.keys(props.formErrors).length > 0}
                      onClearFieldError={props.onClearFieldError}
                    />
                  </>
                )}
              </div>
            </div>
          ) : null
        }
      />

      {/* Document upload */}
      {(props.showDocumentUpload !== false) && (
        <div style={{ marginTop: '24px' }}>
          <SectionLabel>Documents (optional)</SectionLabel>
          <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '8px' }}>
            Upload PDFs, Word docs, or text files for the agent to reference.
            Documents are available while the agent is running.
          </p>
          <input
            type="file"
            multiple
            accept=".txt,.md,.csv,.html,.xml,.json,.pdf,.docx"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              props.onChange({ pendingFiles: files });
            }}
            style={inputStyle}
          />
          {props.value.pendingFiles.length > 0 && (
            <ul style={{ marginTop: '8px' }}>
              {props.value.pendingFiles.map((f, i) => (
                <li key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', flexShrink: 0 }}>({(f.size / 1024).toFixed(0)} KB)</span>
                  <button
                    type="button"
                    onClick={() => {
                      const next = props.value.pendingFiles.filter((_, j) => j !== i);
                      props.onChange({ pendingFiles: next });
                    }}
                    style={{ color: 'var(--color-danger)', fontSize: '12px', marginLeft: 'auto', flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer' }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

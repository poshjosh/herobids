import { useState, useEffect } from 'react';
import { useIntl } from 'react-intl';
import { FieldLabel, inputStyle } from '../../lib/ui.js';
import type { Skill } from '../../lib/api-client.js';
import type { AgentFormState } from './agent-form-state.js';
import { SkillPicker } from './SkillPicker.js';
import { TechnicalConfigSection } from './TechnicalConfigSection.js';
import { AdvancedSettingsSection } from './AdvancedSettingsSection.js';
import { AgentControlsSection } from './AgentControlsSection.js';
import { validateCreateAgentForm, type ValidationConstraints } from './form-validation.js';

// ---------------------------------------------------------------------------
// ADVANCED_FIELD_TAB — maps validated field names to Advanced Settings tab index
// ---------------------------------------------------------------------------

/**
 * Maps validated field names to the Advanced Settings tab index that contains them.
 * Update this whenever a field moves between tabs or a new validated field is added.
 *   0 = AI
 *   1 = Skills
 *   2 = Trading Setup
 *   3 = Strategy
 */
export const ADVANCED_FIELD_TAB: Record<string, number> = {
  // AI
  tickIntervalMins: 0,
  dailySpendBudgetUsd: 0,
  // Trading Setup
  executionMode: 2,
  venue: 2,
  dailyLossLimit: 2,
  maxSlippageBps: 2,
  maxOpenPositions: 2,
  maxPositionSizePct: 2,
  stopLossPct: 2,
  stopLossCooldownSecs: 2,
  openPositionEscalationToJudgePolicy: 2,
  // Strategy
};

// ---------------------------------------------------------------------------
// AgentFormBodyProps
// ---------------------------------------------------------------------------

export interface AgentFormBodyProps {
  // Core form state
  value: AgentFormState;
  onChange: (patch: Partial<AgentFormState>) => void;

  // Display flags (computed by caller)
  showIntelligence: boolean;
  showTechnical: boolean;
  showTradingControls: boolean;
  requiresTradingSetup: boolean;
  isAdmin: boolean;

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
  skillsSlot?: React.ReactNode;
  connectionSlot?: React.ReactNode;
  tradingSetupSlot?: React.ReactNode;
  computeBudgetSlot?: React.ReactNode;
  nameAutoHint?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// AgentFormBody
// ---------------------------------------------------------------------------

export function AgentFormBody(props: AgentFormBodyProps) {
  const intl = useIntl();
  const [advancedExpandSeq, setAdvancedExpandSeq] = useState(0);
  const [advancedErrorTabIdx, setAdvancedErrorTabIdx] = useState(2);

  const hasBotManagementSkill = props.value.skillIds.includes('bot-management');

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
    gap: '4px',
    marginBottom: '14px',
  };

  const errorStyle: React.CSSProperties = {
    color: 'var(--color-danger)',
    fontSize: '12px',
    marginTop: '4px',
  };

  const helperStyle: React.CSSProperties = {
    marginTop: '4px',
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
        <div style={helperStyle}>
          {intl.formatMessage({ id: 'agents.create.telegramChatId.help' })}
        </div>
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

      {/* Technical Pre-Filter Toggle — feature gate shown on main form */}
      {props.requiresTradingSetup && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <div
            role="switch"
            aria-checked={props.value.technicalPreFilterEnabled}
            tabIndex={0}
            onClick={() => props.onChange({ technicalPreFilterEnabled: !props.value.technicalPreFilterEnabled })}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                props.onChange({ technicalPreFilterEnabled: !props.value.technicalPreFilterEnabled });
              }
            }}
            style={{
              position: 'relative',
              width: '40px',
              height: '22px',
              flexShrink: 0,
              borderRadius: '11px',
              background: props.value.technicalPreFilterEnabled ? 'var(--color-brand)' : 'var(--color-border)',
              cursor: 'pointer',
              transition: 'background 0.15s',
            }}
          >
            <div style={{
              position: 'absolute',
              top: '2px',
              left: props.value.technicalPreFilterEnabled ? '20px' : '2px',
              width: '18px',
              height: '18px',
              borderRadius: '50%',
              background: '#fff',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              transition: 'left 0.15s',
            }} />
          </div>
          <span style={{ fontSize: '13px', fontWeight: '500', color: 'var(--color-text-primary)' }}>
            {intl.formatMessage({ id: 'agents.create.technicalPreFilter.help' })}
          </span>
        </div>
      )}

      {/* Advanced Settings (tabs) */}
      <AdvancedSettingsSection
        expandSeq={advancedExpandSeq}
        errorTabIdx={advancedErrorTabIdx}
        formErrors={props.formErrors}
        fieldTabMap={ADVANCED_FIELD_TAB}
        aiConfig={
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {props.modelSlot}
            {props.connectionSlot}
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
          </div>
        }
        skills={
          props.skillsSlot ??
          (props.showIntelligence ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                padding: '16px',
                border: '1px solid var(--color-border)',
                borderRadius: '8px',
                background: 'var(--color-surface-1)',
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: '14px',
                    fontWeight: '600',
                    marginBottom: '4px',
                  }}
                >
                  {intl.formatMessage({ id: 'agents.create.skills' })}
                </div>
                <div
                  style={{
                    fontSize: '13px',
                    color: 'var(--color-text-secondary)',
                    lineHeight: '1.5',
                  }}
                >
                  {intl.formatMessage({ id: 'agents.create.skillsHelp' })}
                </div>
              </div>
              <SkillPicker
                skills={props.selectableSkills}
                selectedSkillIds={props.value.skillIds}
                onChange={(skillIds) => props.onChange({ skillIds })}
                loading={props.skillsLoading}
                errorMessage={props.skillsError}
              />
            </div>
          ) : null)
        }
        tradingSetup={props.tradingSetupSlot}
        strategy={
          props.showTechnical ? (
            <div
              style={{
                padding: '12px',
                border: '1px solid var(--color-border)',
                borderRadius: '8px',
              }}
            >
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: '600',
                  marginBottom: '12px',
                }}
              >
                {intl.formatMessage({ id: 'agents.technical.title' })}
              </div>
              <TechnicalConfigSection
                value={props.value.technicalConfig}
                onChange={(technicalConfig) =>
                  props.onChange({ technicalConfig })
                }
                showErrors={Object.keys(props.formErrors).length > 0}
                onClearFieldError={props.onClearFieldError}
              />
            </div>
          ) : null
        }
      />
    </>
  );
}

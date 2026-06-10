import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, capabilities as capabilitiesApi, skills as skillsApi, auth as authApi, ai as aiApi, type Skill, type TradingBindingSummary } from '../../lib/api-client.js';
import { PageShell, PageHeader, LoadingRows, ErrorState, EmptyState, Button, Modal, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { formatExecutionMode, formatCapabilityFamily, formatSkillSelection, hasCapabilityFamily, listSelectableSkills } from './agent-display.js';
import { AgentSummaryCard } from './AgentSummaryCard.js';
import { SkillPicker } from './SkillPicker.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { ProviderSetupForm } from '../setup/ProviderSetupForm.js';
import { ModelSelectionFields } from '../settings/ModelSelectionFields.js';
import { resolveCreateAgentModelPayload } from './create-agent-models.js';
import { AgentControlsSection } from './AgentControlsSection.js';

type RiskToleranceValue = 'conservative' | 'moderate' | 'aggressive';
type CreateStep = 'intent' | 'review';

interface IntentState {
  goal: string;
  skillIds: string[];
  executionMode: 'paper' | 'shadow' | 'live';
  provider: string;
  lightModel: string;
  heavyModel: string;
  telegramChatId: string;
  tradingBindingId: string;
  riskTolerance: RiskToleranceValue;
  // Configurable controls
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd: string;
  tickIntervalMs: string;
  maxBots: string;
  capital: string;
  dailyLossLimit: string;
  maxSlippageBps: string;
  dailyLlmTokenBudget: string;
}

export function AgentsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const intl = useIntl();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();

  useEffect(() => {
    const createRequested = new URLSearchParams(location.search).get('create') === '1';
    if (createRequested) {
      setShowCreate(true);
    }
  }, [location.search]);

  const query = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });

  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list(),
  });

  const items = query.data ?? [];
  const selectableSkills = listSelectableSkills(skillsQuery.data?.skills ?? []);

  const openCreate = () => {
    setShowCreate(true);
    navigate('/agents?create=1', { replace: true });
  };

  const closeCreate = () => {
    setShowCreate(false);
    navigate('/agents', { replace: true });
  };

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'agents.title' })}
        subtitle={intl.formatMessage({ id: 'agents.subtitle' })}
        action={<Button variant="primary" onClick={openCreate}>{intl.formatMessage({ id: 'agents.newAgent' })}</Button>}
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={localizeApiError(intl, query.error, 'common.errorTitle')} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title={intl.formatMessage({ id: 'agents.empty.title' })}
          message={intl.formatMessage({ id: 'agents.empty.message' })}
          action={<Button variant="primary" onClick={openCreate}>{intl.formatMessage({ id: 'agents.createAgent' })}</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {items.map((agent) => (
            <AgentSummaryCard key={agent.id} agent={agent} onOpen={() => navigate(`/agents/${agent.id}`)} />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateAgentFlow
          skills={selectableSkills}
          skillsLoading={skillsQuery.isLoading}
          skillsError={skillsQuery.error instanceof Error ? skillsQuery.error.message : null}
          onClose={closeCreate}
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

function CreateAgentFlow({
  skills,
  skillsLoading,
  skillsError,
  onClose,
  onCreated,
}: {
  skills: Skill[];
  skillsLoading: boolean;
  skillsError: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const intl = useIntl();
  const qc = useQueryClient();
  const [step, setStep] = useState<CreateStep>('intent');
  const [showSetup, setShowSetup] = useState(false);
  const [intent, setIntent] = useState<IntentState>({
    goal: '',
    skillIds: [],
    executionMode: 'paper',
    provider: '',
    lightModel: '',
    heavyModel: '',
    telegramChatId: '',
    tradingBindingId: '',
    riskTolerance: 'moderate',
    costPreset: '',
    dailySpendBudgetUsd: '',
    tickIntervalMs: '',
    maxBots: '',
    capital: '',
    dailyLossLimit: '',
    maxSlippageBps: '',
    dailyLlmTokenBudget: '',
  });
  const [modelTouched, setModelTouched] = useState(false);
  const [telegramTouched, setTelegramTouched] = useState(false);

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me(),
  });
  const aiSettingsQuery = useQuery({
    queryKey: ['ai', 'settings'],
    queryFn: () => aiApi.settings(),
  });
  const availableModelsQuery = useQuery({
    queryKey: ['ai', 'available-models'],
    queryFn: () => aiApi.availableModels(),
  });

  useEffect(() => {
    if (modelTouched) {
      return;
    }
    const savedModels = aiSettingsQuery.data?.aiModelConfig;
    if (savedModels) {
      setIntent((state) => ({
        ...state,
        provider: savedModels.provider,
        lightModel: savedModels.lightModel,
        heavyModel: savedModels.heavyModel,
      }));
    }
  }, [aiSettingsQuery.data?.aiModelConfig, modelTouched]);

  useEffect(() => {
    if (telegramTouched) {
      return;
    }
    const chatId = meQuery.data?.telegramChatId;
    if (chatId !== undefined) {
      setIntent((state) => ({ ...state, telegramChatId: chatId ?? '' }));
    }
  }, [meQuery.data?.telegramChatId, telegramTouched]);

  const selectedSkills = skills.filter((skill) => intent.skillIds.includes(skill.id));
  const savedModelSettings = aiSettingsQuery.data?.aiModelConfig ?? null;
  const modelPayload = resolveCreateAgentModelPayload(
    { provider: intent.provider, lightModel: intent.lightModel, heavyModel: intent.heavyModel },
    savedModelSettings,
  );
  const requiresTradingSetup = hasCapabilityFamily(selectedSkills, 'trading');
  const tradingBindingsQuery = useQuery({
    queryKey: ['capabilities', 'trading', 'bindings'],
    queryFn: () => capabilitiesApi.tradingBindings(),
  });
  const availableTradingBindings = (tradingBindingsQuery.data?.bindings ?? []).filter(
    (binding) => binding.status === 'active' && binding.connectionStatus === 'active',
  );
  const selectedTradingBinding = availableTradingBindings.find((binding) => binding.bindingId === intent.tradingBindingId) ?? null;

  const mutation = useMutation({
    mutationFn: async () => {
      const name = intent.goal.length > 60 ? `${intent.goal.slice(0, 57)}…` : intent.goal;
      const agent = await agentsApi.create({
        name,
        prompt: buildPrompt(intent, selectedSkills, selectedTradingBinding),
        skillIds: [...intent.skillIds],
        executionMode: intent.executionMode,
        ...(!modelPayload.inherits ? {
          provider: modelPayload.provider,
          lightModel: modelPayload.lightModel,
          heavyModel: modelPayload.heavyModel,
        } : {}),
        costPreset: intent.costPreset || null,
        dailySpendBudgetUsd: intent.dailySpendBudgetUsd ? parseFloat(intent.dailySpendBudgetUsd) : null,
        telegramChatId: intent.telegramChatId.trim() || null,
        tickIntervalMs: intent.tickIntervalMs ? parseInt(intent.tickIntervalMs, 10) : null,
        maxBots: intent.maxBots ? parseInt(intent.maxBots, 10) : null,
        capital: intent.capital.trim() || null,
        dailyLossLimit: intent.dailyLossLimit.trim() || null,
        maxSlippageBps: intent.maxSlippageBps ? parseInt(intent.maxSlippageBps, 10) : null,
        dailyLlmTokenBudget: intent.dailyLlmTokenBudget ? parseInt(intent.dailyLlmTokenBudget, 10) : null,
      });

      if (requiresTradingSetup && intent.tradingBindingId) {
        await agentsApi.tradingAction(agent.id, 'bind', { bindingId: intent.tradingBindingId });
      }

      return agent;
    },
    onSuccess: (agent) => onCreated(agent.id),
  });

  if (showSetup) {
    return (
      <ProviderSetupForm
        onClose={() => setShowSetup(false)}
        onSuccess={(result) => {
          setShowSetup(false);
          void qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'bindings'] });
          if (result.tradingBinding) {
            setIntent((state) => ({ ...state, tradingBindingId: result.tradingBinding!.id }));
          }
        }}
      />
    );
  }

  if (step === 'intent') {
    const riskOptions = [
      {
        value: 'conservative',
        label: intl.formatMessage({ id: 'agents.risk.conservative.label' }),
        description: intl.formatMessage({ id: 'agents.risk.conservative.description' }),
      },
      {
        value: 'moderate',
        label: intl.formatMessage({ id: 'agents.risk.moderate.label' }),
        description: intl.formatMessage({ id: 'agents.risk.moderate.description' }),
      },
      {
        value: 'aggressive',
        label: intl.formatMessage({ id: 'agents.risk.aggressive.label' }),
        description: intl.formatMessage({ id: 'agents.risk.aggressive.description' }),
      },
    ] as const;

    return (
      <Modal title={intl.formatMessage({ id: 'agents.create.title' })} onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <FieldLabel>{intl.formatMessage({ id: 'agents.create.goal' })}</FieldLabel>
            <textarea
              style={{ ...inputStyle, minHeight: '72px', resize: 'vertical' }}
              value={intent.goal}
              onChange={(e) => setIntent((state) => ({ ...state, goal: e.target.value }))}
              placeholder={intl.formatMessage({ id: 'agents.create.goalPlaceholder' })}
              required
            />
          </div>

          <div>
            <FieldLabel>{intl.formatMessage({ id: 'agents.create.skills' })}</FieldLabel>
            <SkillPicker
              skills={skills}
              selectedSkillIds={intent.skillIds}
              onChange={(skillIds) => setIntent((state) => ({ ...state, skillIds }))}
              loading={skillsLoading}
              errorMessage={skillsError}
            />
            <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
              {intl.formatMessage({ id: 'agents.create.skillsHelp' })}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface-1)' }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '4px' }}>
                {intl.formatMessage({ id: 'agents.create.models.title' })}
              </div>
              <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                {intl.formatMessage({ id: 'agents.create.models.description' })}
              </div>
            </div>

            <ModelSelectionFields
              value={{ provider: intent.provider, lightModel: intent.lightModel, heavyModel: intent.heavyModel }}
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
              onChange={(value) => {
                setModelTouched(true);
                setIntent((state) => ({ ...state, ...value }));
              }}
            />
          </div>

          <div>
            <FieldLabel>{intl.formatMessage({ id: 'agents.executionMode.label' })}</FieldLabel>
            <select
              value={intent.executionMode}
              onChange={(e) => setIntent((state) => ({ ...state, executionMode: e.target.value as IntentState['executionMode'] }))}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="paper">{intl.formatMessage({ id: 'agents.create.executionMode.paper' })}</option>
              <option value="shadow">{intl.formatMessage({ id: 'agents.create.executionMode.shadow' })}</option>
              <option value="live">{intl.formatMessage({ id: 'agents.create.executionMode.live' })}</option>
            </select>
          </div>

          <div>
            <FieldLabel>{intl.formatMessage({ id: 'agents.create.telegramChatId' })}</FieldLabel>
            <input
              style={inputStyle}
              value={intent.telegramChatId}
              onChange={(e) => {
                setTelegramTouched(true);
                setIntent((state) => ({ ...state, telegramChatId: e.target.value }));
              }}
              placeholder={intl.formatMessage({ id: 'agents.create.telegramChatId.placeholder' })}
            />
            <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
              {intl.formatMessage({ id: 'agents.create.telegramChatId.help' })}
            </div>
          </div>

          <AgentControlsSection
            value={{
              costPreset: intent.costPreset,
              dailySpendBudgetUsd: intent.dailySpendBudgetUsd,
              tickIntervalMs: intent.tickIntervalMs,
              maxBots: intent.maxBots,
              capital: intent.capital,
              dailyLossLimit: intent.dailyLossLimit,
              maxSlippageBps: intent.maxSlippageBps,
              dailyLlmTokenBudget: intent.dailyLlmTokenBudget,
            }}
            onChange={(patch) => setIntent((state) => ({ ...state, ...patch }))}
          />

          {requiresTradingSetup && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface-1)' }}>
              <div>
                <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '4px' }}>
                  {intl.formatMessage({ id: 'agents.create.capabilitySetupTitle' }, { capability: formatCapabilityFamily('trading', intl) })}
                </div>
                <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                  {intl.formatMessage({ id: 'agents.create.capabilitySetupMessage' })}
                </div>
              </div>

              <div>
                <FieldLabel>{intl.formatMessage({ id: 'agents.create.tradingBinding' })}</FieldLabel>
                {tradingBindingsQuery.isLoading ? (
                  <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.create.loadingBindings' })}</div>
                ) : availableTradingBindings.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                      {intl.formatMessage({ id: 'agents.create.noBindings' })}
                    </div>
                    <div>
                      <Button variant="secondary" size="sm" onClick={() => setShowSetup(true)}>
                        {intl.formatMessage({ id: 'agents.create.setupTradingNow' })}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <select
                    value={intent.tradingBindingId}
                    onChange={(e) => setIntent((state) => ({ ...state, tradingBindingId: e.target.value }))}
                    style={{ ...inputStyle, cursor: 'pointer' }}
                  >
                    <option value="">{intl.formatMessage({ id: 'agents.create.chooseBinding' })}</option>
                    {availableTradingBindings.map((binding) => (
                      <option key={binding.bindingId} value={binding.bindingId}>
                        {binding.label} ({binding.provider})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <FieldLabel>{intl.formatMessage({ id: 'agents.create.riskTolerance' })}</FieldLabel>
                <select
                  value={intent.riskTolerance}
                  onChange={(e) => setIntent((state) => ({ ...state, riskTolerance: e.target.value as RiskToleranceValue }))}
                  style={{ ...inputStyle, cursor: 'pointer' }}
                >
                  {riskOptions.map((risk) => (
                    <option key={risk.value} value={risk.value}>
                      {risk.label} — {risk.description}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={onClose} type="button">{intl.formatMessage({ id: 'common.cancel' })}</Button>
            <Button
              variant="primary"
              type="button"
              disabled={!intent.goal.trim() || !intent.provider || !intent.lightModel || !intent.heavyModel}
              onClick={() => setStep('review')}
            >
              {intl.formatMessage({ id: 'agents.create.review' })}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={intl.formatMessage({ id: 'agents.review.title' })} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ padding: '12px', background: 'var(--color-bg-subtle, rgba(0,0,0,0.04))', borderRadius: '6px', fontSize: '14px', lineHeight: '1.5' }}>
          {intent.goal}
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <tbody>
            <ReviewRow label={intl.formatMessage({ id: 'agents.executionMode.label' })} value={formatExecutionMode(intent.executionMode, intl)} />
            <ReviewRow
              label={intl.formatMessage({ id: 'agents.review.models' })}
              value={modelPayload.inherits
                ? intl.formatMessage({ id: 'agents.review.models.inherit' })
                : intent.provider
                ? intl.formatMessage(
                  { id: 'agents.review.models.value' },
                  { provider: intent.provider, lightModel: intent.lightModel || intl.formatMessage({ id: 'common.default' }), heavyModel: intent.heavyModel || intl.formatMessage({ id: 'common.default' }) },
                )
                : intl.formatMessage({ id: 'agents.review.models.inherit' })}
            />
            <ReviewRow label={intl.formatMessage({ id: 'agents.create.skills' })} value={formatSkillSelection(selectedSkills, intl)} />
            <ReviewRow
              label={intl.formatMessage({ id: 'agents.review.capabilitySetup' })}
              value={requiresTradingSetup
                ? (selectedTradingBinding
                  ? intl.formatMessage({ id: 'agents.review.capabilitySetup.bound' })
                  : intl.formatMessage({ id: 'agents.review.capabilitySetup.defer' }))
                : intl.formatMessage({ id: 'agents.review.capabilitySetup.none' })}
            />
            {requiresTradingSetup && selectedTradingBinding && (
              <ReviewRow label={intl.formatMessage({ id: 'agents.create.tradingBinding' })} value={`${selectedTradingBinding.label} (${selectedTradingBinding.provider})`} />
            )}
          </tbody>
        </table>

        {mutation.isError && <ErrorBanner message={localizeApiError(intl, mutation.error, 'common.errorTitle')} />}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'space-between' }}>
          <Button variant="ghost" onClick={() => setStep('intent')} type="button">{intl.formatMessage({ id: 'common.back' })}</Button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button variant="ghost" onClick={onClose} type="button">{intl.formatMessage({ id: 'common.cancel' })}</Button>
            <Button variant="primary" type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending ? intl.formatMessage({ id: 'agents.create.creating' }) : intl.formatMessage({ id: 'agents.createAgent' })}
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

function buildPrompt(intent: IntentState, selectedSkills: Skill[], selectedTradingBinding: TradingBindingSummary | null): string {
  const goal = intent.goal.trim();
  const operatorContext: string[] = [];

  if (selectedSkills.length > 0) {
    operatorContext.push(`Selected skills: ${formatSkillSelection(selectedSkills)}.`);
  }

  if (hasCapabilityFamily(selectedSkills, 'trading')) {
    operatorContext.push('Trading capability selected.');
    if (selectedTradingBinding) {
      operatorContext.push(`Selected trading binding: ${selectedTradingBinding.label} (${selectedTradingBinding.provider}).`);
    }
    operatorContext.push(`Risk tolerance: ${intent.riskTolerance}.`);
  }

  if (operatorContext.length === 0) {
    return goal;
  }

  return `${goal}\n\nOperator context:\n${operatorContext.map((line) => `- ${line}`).join('\n')}`;
}

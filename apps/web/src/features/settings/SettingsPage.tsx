import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { getAllowedReasoningLevels, RUNTIME_POLICY_CEILINGS } from '@herobids/domain';
import { auth as authApi, ai as aiApi, type AiModelSettingsUpdate } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, Button, FieldLabel, ErrorBanner } from '../../lib/ui.js';
import { useLocale } from '../../app/i18n/I18nProvider.js';
import type { SupportedLocale } from '../../app/i18n/resolveLocale.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { ModelSelectionFields, resolveDefaultModelSelection } from './ModelSelectionFields.js';
import { EMPTY_AI_MODEL_SELECTION, createClearedAiModelSettings, normalizeAiModelSelection, shouldDisableAiModelSave, type AiModelSelectionState } from './ai-model-settings.js';

const LOCALE_DISPLAY_NAMES: Record<SupportedLocale, string> = {
  en: 'English',
  ar: 'العربية',
  hi: 'हिन्दी',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid var(--color-border)',
  borderRadius: '6px',
  background: 'var(--color-surface-2)',
  color: 'var(--color-text)',
  fontSize: '14px',
  boxSizing: 'border-box',
};

export function SettingsPage() {
  const qc = useQueryClient();
  const intl = useIntl();
  const { locale, setLocale, supportedLocales } = useLocale();

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me(),
  });

  const availableModelsQuery = useQuery({
    queryKey: ['ai', 'available-models'],
    queryFn: () => aiApi.availableModels(),
  });

  const aiSettingsQuery = useQuery({
    queryKey: ['ai', 'settings'],
    queryFn: () => aiApi.settings(),
  });

  const [telegramChatId, setTelegramChatId] = useState<string>('');
  const [saved, setSaved] = useState(false);
  const savedTelegramChatId = meQuery.data?.telegramChatId ?? '';
  const savedEmailEnabled = meQuery.data?.notificationPreferences?.sendMessage?.email?.enabled ?? true;
  const [emailEnabled, setEmailEnabled] = useState<boolean>(true);
  const [emailDeliverySaved, setEmailDeliverySaved] = useState(false);
  const [modelSettings, setModelSettings] = useState<AiModelSelectionState>(EMPTY_AI_MODEL_SELECTION);
  const [modelTouched, setModelTouched] = useState(false);
  const [modelSaved, setModelSaved] = useState(false);
  const savedModelSettings = aiSettingsQuery.data?.aiModelConfig ?? null;

  // Only react to changes in the saved Telegram value. Locale-only profile
  // updates also refresh the ['me'] query and should not overwrite the input.
  useEffect(() => {
    setTelegramChatId(savedTelegramChatId);
  }, [savedTelegramChatId]);

  useEffect(() => {
    setEmailEnabled(savedEmailEnabled);
  }, [savedEmailEnabled]);

  useEffect(() => {
    if (modelTouched) {
      return;
    }
    setModelSettings(normalizeAiModelSelection(savedModelSettings));
  }, [modelTouched, savedModelSettings]);

  useEffect(() => {
    if (modelTouched) {
      return;
    }
    if (modelSettings.provider) {
      return;
    }
    if (!aiSettingsQuery.isSuccess || savedModelSettings) {
      return;
    }
    const defaultSelection = resolveDefaultModelSelection(availableModelsQuery.data?.providers ?? [], availableModelsQuery.data?.defaults);
    if (!defaultSelection) {
      return;
    }
    setModelSettings({ ...modelSettings, ...defaultSelection });
  }, [availableModelsQuery.data?.providers, aiSettingsQuery.isSuccess, modelSettings.provider, modelTouched, savedModelSettings]);

  const telegramMutation = useMutation({
    mutationFn: (chatId: string) => authApi.updateMe({ telegramChatId: chatId.trim() || null }),
    onSuccess: (updated) => {
      qc.setQueryData(['me'], updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  const emailMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      authApi.updateMe({ notificationPreferences: { sendMessage: { email: { enabled } } } }),
    onSuccess: (updated) => {
      qc.setQueryData(['me'], updated);
      setEmailDeliverySaved(true);
      setTimeout(() => setEmailDeliverySaved(false), 3000);
    },
  });

  const localeMutation = useMutation({
    mutationKey: ['locale'],
    mutationFn: (nextLocale: SupportedLocale) => authApi.updateMe({ preferredLocale: nextLocale }),
    onMutate: (nextLocale) => {
      const previousLocale = locale;
      setLocale(nextLocale);
      return { previousLocale };
    },
    onSuccess: (updated) => {
      qc.setQueryData(['me'], updated);
    },
    onError: (_error, _nextLocale, context) => {
      if (context?.previousLocale) {
        setLocale(context.previousLocale);
      }
    },
  });

  const modelMutation = useMutation({
    mutationFn: (nextSettings: AiModelSettingsUpdate) => aiApi.updateSettings(nextSettings),
    onSuccess: (updated) => {
      qc.setQueryData(['ai', 'settings'], updated);
      setModelTouched(false);
      setModelSettings(normalizeAiModelSelection(updated.aiModelConfig));
      setModelSaved(true);
      setTimeout(() => setModelSaved(false), 3000);
    },
  });
  const modelSaveDisabled = shouldDisableAiModelSave(modelSettings, savedModelSettings, modelMutation.isPending);

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'settings.title' })}
        subtitle={intl.formatMessage({ id: 'settings.subtitle' })}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '540px' }}>
        {/* Language preference */}
        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>
            {intl.formatMessage({ id: 'settings.locale.title' })}
          </h3>
          {localeMutation.isError && (
            <ErrorBanner message={localizeApiError(intl, localeMutation.error, 'common.errorTitle')} />
          )}
          <div>
            <FieldLabel>{intl.formatMessage({ id: 'settings.locale.label' })}</FieldLabel>
            <select
              aria-label={intl.formatMessage({ id: 'settings.locale.label' })}
              value={locale}
              onChange={(e) => localeMutation.mutate(e.target.value as SupportedLocale)}
              disabled={localeMutation.isPending}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              {supportedLocales.map((loc) => (
                <option key={loc} value={loc}>
                  {LOCALE_DISPLAY_NAMES[loc]}
                </option>
              ))}
            </select>
          </div>
        </Card>

        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>
            {intl.formatMessage({ id: 'aiModels.title' })}
          </h3>
          <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
            {intl.formatMessage({ id: 'aiModels.description' })}
          </p>

          {modelMutation.isError && (
            <ErrorBanner message={localizeApiError(intl, modelMutation.error, 'common.errorTitle')} />
          )}
          {modelSaved && (
            <div style={{ marginBottom: '12px', padding: '8px 12px', borderRadius: '6px', background: 'var(--color-success-subtle)', color: 'var(--color-success)', fontSize: '13px' }}>
              {intl.formatMessage({ id: 'aiModels.saved' })}
            </div>
          )}
          {availableModelsQuery.isError && (
            <ErrorBanner message={localizeApiError(intl, availableModelsQuery.error, 'common.errorTitle')} />
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              setModelTouched(true);
              modelMutation.mutate({
                provider: modelSettings.provider,
                lightModel: modelSettings.lightModel,
                heavyModel: modelSettings.heavyModel,
                scoutReasoning: modelSettings.scoutReasoning ?? null,
                judgeReasoning: modelSettings.judgeReasoning ?? null,
                adaptScoutReasoning: modelSettings.adaptScoutReasoning,
                adaptJudgeReasoning: modelSettings.adaptJudgeReasoning,
              });
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
          >
            <ModelSelectionFields
              value={modelSettings}
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
                setModelSettings({ ...modelSettings, ...value });
              }}
            />

            {/* Reasoning levels side by side */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <FieldLabel>{intl.formatMessage({ id: 'aiModels.scoutReasoning.label' })}</FieldLabel>
                <select
                  aria-label={intl.formatMessage({ id: 'aiModels.scoutReasoning.label' })}
                  value={modelSettings.scoutReasoning}
                  onChange={(e) => {
                    setModelTouched(true);
                    setModelSettings({ ...modelSettings, scoutReasoning: e.target.value });
                  }}
                  style={{ ...inputStyle, cursor: 'pointer' }}
                >
                  {getAllowedReasoningLevels(RUNTIME_POLICY_CEILINGS.scoutReasoningMax).map((level) => (
                    <option key={level} value={level}>{intl.formatMessage({ id: `aiModels.reasoning.${level}` })}</option>
                  ))}
                </select>
                <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                  {intl.formatMessage({ id: 'aiModels.scoutReasoning.help' })}
                </div>
              </div>
              <div>
                <FieldLabel>{intl.formatMessage({ id: 'aiModels.judgeReasoning.label' })}</FieldLabel>
                <select
                  aria-label={intl.formatMessage({ id: 'aiModels.judgeReasoning.label' })}
                  value={modelSettings.judgeReasoning}
                  onChange={(e) => {
                    setModelTouched(true);
                    setModelSettings({ ...modelSettings, judgeReasoning: e.target.value });
                  }}
                  style={{ ...inputStyle, cursor: 'pointer' }}
                >
                  <option value="none">{intl.formatMessage({ id: 'aiModels.reasoning.none' })}</option>
                  <option value="low">{intl.formatMessage({ id: 'aiModels.reasoning.low' })}</option>
                  <option value="medium">{intl.formatMessage({ id: 'aiModels.reasoning.medium' })}</option>
                  <option value="high">{intl.formatMessage({ id: 'aiModels.reasoning.high' })}</option>
                </select>
                <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                  {intl.formatMessage({ id: 'aiModels.judgeReasoning.help' })}
                </div>
              </div>
            </div>

            {/* Adaptive reasoning toggles — side by side (matching reasoning levels grid) */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label htmlFor="adapt-scout-reasoning" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', color: 'var(--color-text)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    id="adapt-scout-reasoning"
                    checked={modelSettings.adaptScoutReasoning}
                    onChange={(e) => {
                      setModelTouched(true);
                      setModelSettings({ ...modelSettings, adaptScoutReasoning: e.target.checked });
                    }}
                  />
                  {intl.formatMessage({ id: 'settings.adaptiveScoutReasoning' })}
                </label>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.4' }}>
                  {intl.formatMessage({ id: 'settings.adaptiveScoutReasoningHelp' })}
                </p>
              </div>
              <div>
                <label htmlFor="adapt-judge-reasoning" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', color: 'var(--color-text)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    id="adapt-judge-reasoning"
                    checked={modelSettings.adaptJudgeReasoning}
                    onChange={(e) => {
                      setModelTouched(true);
                      setModelSettings({ ...modelSettings, adaptJudgeReasoning: e.target.checked });
                    }}
                  />
                  {intl.formatMessage({ id: 'settings.adaptiveJudgeReasoning' })}
                </label>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.4' }}>
                  {intl.formatMessage({ id: 'settings.adaptiveJudgeReasoningHelp' })}
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <Button variant="primary" type="submit" disabled={modelSaveDisabled}>
                {modelMutation.isPending
                  ? intl.formatMessage({ id: 'common.pleaseWait' })
                  : intl.formatMessage({ id: 'settings.save' })}
              </Button>
              {savedModelSettings && (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    setModelTouched(true);
                    modelMutation.mutate(createClearedAiModelSettings());
                  }}
                  disabled={modelMutation.isPending}
                >
                  {intl.formatMessage({ id: 'common.remove' })}
                </Button>
              )}
            </div>
          </form>
        </Card>

        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>
            {intl.formatMessage({ id: 'settings.telegram.title' })}
          </h3>
          <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
            {intl.formatMessage({ id: 'settings.telegram.description' })}
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              telegramMutation.mutate(telegramChatId);
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
          >
            {telegramMutation.isError && (
              <ErrorBanner message={localizeApiError(intl, telegramMutation.error, 'common.errorTitle')} />
            )}
            {saved && (
              <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'var(--color-success-subtle)', color: 'var(--color-success)', fontSize: '13px' }}>
                {intl.formatMessage({ id: 'settings.telegram.saved' })}
              </div>
            )}

            <div>
              <FieldLabel>{intl.formatMessage({ id: 'settings.telegram.chatId.label' })}</FieldLabel>
              <input
                style={inputStyle}
                value={telegramChatId}
                onChange={(e) => setTelegramChatId(e.target.value)}
                placeholder={intl.formatMessage({ id: 'settings.telegram.chatId.placeholder' })}
              />
            </div>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <Button variant="primary" type="submit" disabled={telegramMutation.isPending || telegramChatId.trim() === savedTelegramChatId}>
                {telegramMutation.isPending
                  ? intl.formatMessage({ id: 'common.pleaseWait' })
                  : intl.formatMessage({ id: 'settings.save' })}
              </Button>
              {telegramChatId && (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    setTelegramChatId('');
                    telegramMutation.mutate('');
                  }}
                  disabled={telegramMutation.isPending}
                >
                  {intl.formatMessage({ id: 'common.remove' })}
                </Button>
              )}
            </div>
          </form>
        </Card>

        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>
            {intl.formatMessage({ id: 'settings.emailDelivery.title' })}
          </h3>
          <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
            {intl.formatMessage({ id: 'settings.emailDelivery.description' })}
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              emailMutation.mutate(emailEnabled);
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
          >
            {emailMutation.isError && (
              <ErrorBanner message={localizeApiError(intl, emailMutation.error, 'common.errorTitle')} />
            )}
            {emailDeliverySaved && (
              <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'var(--color-success-subtle)', color: 'var(--color-success)', fontSize: '13px' }}>
                {intl.formatMessage({ id: 'settings.emailDelivery.saved' })}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
              <input
                type="checkbox"
                id="email-delivery-toggle"
                checked={emailEnabled}
                onChange={(e) => setEmailEnabled(e.target.checked)}
                disabled={emailMutation.isPending}
                style={{ marginTop: '2px', flexShrink: 0 }}
              />
              <div>
                <label htmlFor="email-delivery-toggle" style={{ fontSize: '14px', color: 'var(--color-text)', cursor: 'pointer' }}>
                  {intl.formatMessage({ id: 'settings.emailDelivery.label' })}
                </label>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.4' }}>
                  {intl.formatMessage({ id: 'settings.emailDelivery.help.delivery' })}
                  {meQuery.data?.email ? (
                    <> (<strong style={{ color: 'var(--color-text)' }}>{meQuery.data.email}</strong>)</>
                  ) : null}.{' '}
                  {intl.formatMessage({ id: 'settings.emailDelivery.help.agentOverride' })}
                </p>
              </div>
            </div>

            <div>
              <Button
                variant="primary"
                type="submit"
                disabled={emailEnabled === savedEmailEnabled || emailMutation.isPending}
              >
                {emailMutation.isPending
                  ? intl.formatMessage({ id: 'common.pleaseWait' })
                  : intl.formatMessage({ id: 'settings.save' })}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </PageShell>
  );
}

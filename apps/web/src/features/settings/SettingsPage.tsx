import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { auth as authApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, Button, FieldLabel, ErrorBanner } from '../../lib/ui.js';
import { useLocale } from '../../app/i18n/I18nProvider.js';
import type { SupportedLocale } from '../../app/i18n/resolveLocale.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

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

  const [telegramChatId, setTelegramChatId] = useState<string>('');
  const [saved, setSaved] = useState(false);
  const savedTelegramChatId = meQuery.data?.telegramChatId ?? '';

  // Only react to changes in the saved Telegram value. Locale-only profile
  // updates also refresh the ['me'] query and should not overwrite the input.
  useEffect(() => {
    setTelegramChatId(savedTelegramChatId);
  }, [savedTelegramChatId]);

  const telegramMutation = useMutation({
    mutationFn: (chatId: string) => authApi.updateMe({ telegramChatId: chatId.trim() || null }),
    onSuccess: (updated) => {
      qc.setQueryData(['me'], updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
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
      </div>
    </PageShell>
  );
}

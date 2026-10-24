import { useIntl } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { auth as authApi } from '../../lib/api-client.js';
import { Card, ErrorBanner } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

export interface EmailFallbackToggleViewProps {
  enabled: boolean;
  busy: boolean;
  saved: boolean;
  errorMessage: string | null;
  onChange: (enabled: boolean) => void;
}

const headingStyle: React.CSSProperties = { margin: '0 0 12px', fontSize: '0.875rem', fontWeight: '600' };
const bodyStyle: React.CSSProperties = { margin: '0 0 16px', fontSize: '0.8125rem', color: 'var(--color-text-muted)', lineHeight: '1.5' };

/** Presentational only, so the copy and states can be tested without a browser (082 E7). */
export function EmailFallbackToggleView({ enabled, busy, saved, errorMessage, onChange }: EmailFallbackToggleViewProps) {
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });

  return (
    <Card>
      <h3 style={headingStyle}>{t('settings.emailFallback.title')}</h3>
      <p style={bodyStyle}>{t('settings.emailFallback.description')}</p>
      {errorMessage && <ErrorBanner message={errorMessage} />}
      {saved && (
        <div role="status" style={{ marginBottom: '12px', padding: '8px 12px', borderRadius: '6px', background: 'var(--color-success-subtle)', color: 'var(--color-success)', fontSize: '0.8125rem' }}>
          {t('settings.emailFallback.saved')}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
        <input
          type="checkbox"
          id="email-fallback-toggle"
          checked={enabled}
          disabled={busy}
          onChange={(e) => onChange(e.target.checked)}
          style={{ marginTop: '2px', flexShrink: 0 }}
        />
        <div>
          <label htmlFor="email-fallback-toggle" style={{ fontSize: '0.875rem', color: 'var(--color-text)', cursor: 'pointer' }}>
            {t('settings.emailFallback.label')}
          </label>
          <p style={{ margin: '4px 0 0', fontSize: '0.75rem', color: 'var(--color-text-muted)', lineHeight: '1.4' }}>
            {t('settings.emailFallback.help')}
          </p>
        </div>
      </div>
    </Card>
  );
}

/** Stored per user in users.notificationPreferences.notifications.emailFallback (instance config, not YAML). */
export function EmailFallbackToggle() {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me(),
  });
  const saveMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      authApi.updateMe({ notificationPreferences: { notifications: { emailFallback: { enabled } } } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['me'], updated);
    },
  });

  return (
    <EmailFallbackToggleView
      enabled={meQuery.data?.emailFallbackEnabled === true}
      busy={!meQuery.isSuccess || saveMutation.isPending}
      saved={saveMutation.isSuccess}
      errorMessage={saveMutation.isError ? localizeApiError(intl, saveMutation.error, 'common.errorTitle') : null}
      onChange={(enabled) => saveMutation.mutate(enabled)}
    />
  );
}

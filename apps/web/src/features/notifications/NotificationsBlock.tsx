import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useIntl } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { auth, push } from '../../lib/api-client.js';
import { chatAddressFor } from '../../lib/chat-addresses.js';
import { Button, Card, ErrorBanner } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { readBrowserPushEnvironment } from '../../lib/push/push-browser.js';
import { ConnectTelegram } from './ConnectTelegram.js';
import { PushOptIn } from './PushOptIn.js';
import { telegramDisconnectBody } from './telegram-connect.js';
import {
  readDismissedForSession,
  rememberDismissedForSession,
  resolveNotificationsBlock,
  shouldRecordSubscription,
  type NotificationsBlockVariant,
} from './notifications-block.js';

const headingStyle: CSSProperties = { margin: '0 0 8px', fontSize: '0.875rem', fontWeight: '600' };
const introStyle: CSSProperties = {
  margin: '0 0 12px',
  padding: '8px 12px',
  borderLeft: '3px solid var(--color-brand)',
  fontSize: '0.8125rem',
  color: 'var(--color-text)',
  lineHeight: '1.5',
};
const rowStyle: CSSProperties = { borderTop: '1px solid var(--color-border)', paddingTop: '16px', marginTop: '16px' };
const closeStyle: CSSProperties = {
  position: 'absolute',
  top: '12px',
  right: '12px',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: '4px',
  borderRadius: '4px',
  color: 'var(--color-text-muted)',
  fontSize: '1.125rem',
  lineHeight: '1',
};

interface NotificationsBlockProps {
  variant: NotificationsBlockVariant;
  style?: CSSProperties;
}

/**
 * Telegram and browser notification setup. Settings shows it with the current state.
 * Other pages show it only until a channel is set up (see resolveNotificationsBlock).
 */
export function NotificationsBlock({ variant, style }: NotificationsBlockProps) {
  const intl = useIntl();
  const qc = useQueryClient();
  const [dismissed, setDismissed] = useState(readDismissedForSession);
  const [browserSubscribed, setBrowserSubscribed] = useState(false);
  const recorded = useRef(false);

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => auth.me(),
  });
  const config = useQuery({
    queryKey: ['push', 'config'],
    queryFn: () => push.config(),
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Reads browser state only. Permission is never requested here.
  useEffect(() => {
    let active = true;
    void readBrowserPushEnvironment().then((env) => {
      if (active) setBrowserSubscribed(env.subscribed);
    });
    return () => {
      active = false;
    };
  }, []);

  const saveChoice = useMutation({
    mutationFn: (enabled: boolean) => auth.updateMe({ notificationPreferences: { notifications: { push: { enabled } } } }),
    onSuccess: (updated) => {
      qc.setQueryData(['me'], updated);
    },
  });

  const telegramLinked = chatAddressFor(meQuery.data?.chatAddresses, 'telegram') !== '';
  const pushAvailable = config.data?.enabled === true;
  const savedPushEnabled = meQuery.data?.notificationPreferences?.notifications?.push?.enabled;

  // A browser subscription the profile does not yet record is saved once.
  useEffect(() => {
    if (recorded.current || !meQuery.isSuccess) return;
    if (!shouldRecordSubscription({ pushAvailable, browserSubscribed, savedPushEnabled })) return;
    recorded.current = true;
    saveChoice.mutate(true);
  }, [meQuery.isSuccess, pushAvailable, browserSubscribed, savedPushEnabled]);

  const disconnectTelegram = useMutation({
    mutationFn: () => auth.updateMe(telegramDisconnectBody()),
    onSuccess: (updated) => {
      qc.setQueryData(['me'], updated);
    },
  });

  const view = resolveNotificationsBlock({
    variant,
    profileLoaded: meQuery.isSuccess,
    telegramLinked,
    pushAvailable,
    browserSubscribed,
    dismissed,
  });

  if (!view.show) return null;

  const handleBrowserChoice = (enabled: boolean) => {
    setBrowserSubscribed(enabled);
    saveChoice.mutate(enabled);
  };

  const handleCancel = () => {
    rememberDismissedForSession();
    setDismissed(true);
  };

  return (
    <Card style={{ position: 'relative', ...style }}>
      {view.showCancel && (
        <button
          type="button"
          onClick={handleCancel}
          aria-label={intl.formatMessage({ id: 'common.cancel' })}
          title={intl.formatMessage({ id: 'common.cancel' })}
          style={closeStyle}
        >
          ✕
        </button>
      )}

      <h3 style={{ ...headingStyle, fontSize: '1rem' }}>{intl.formatMessage({ id: 'notifications.block.title' })}</h3>
      <p style={introStyle}>{intl.formatMessage({ id: 'notifications.block.intro' })}</p>

      {view.showTelegram && (
        <section style={rowStyle}>
          <h3 style={headingStyle}>{intl.formatMessage({ id: 'notifications.block.telegramTitle' })}</h3>
          {disconnectTelegram.isError && (
            <ErrorBanner message={localizeApiError(intl, disconnectTelegram.error, 'common.errorTitle')} />
          )}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <ConnectTelegram />
            {variant === 'settings' && telegramLinked && (
              <Button
                variant="secondary"
                type="button"
                onClick={() => disconnectTelegram.mutate()}
                disabled={disconnectTelegram.isPending}
              >
                {intl.formatMessage({ id: 'settings.telegram.disconnect' })}
              </Button>
            )}
          </div>
        </section>
      )}

      {view.showBrowser && (
        <section style={rowStyle}>
          <PushOptIn embedded onChange={handleBrowserChoice} />
        </section>
      )}
    </Card>
  );
}

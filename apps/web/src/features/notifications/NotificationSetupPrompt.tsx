import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useIntl } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { auth, push, type MeResponse } from '../../lib/api-client.js';
import { readBrowserPushEnvironment } from '../../lib/push/push-browser.js';
import type { PushEnvironment } from '../../lib/push/push-opt-in-state.js';
import { PushOptIn } from './PushOptIn.js';

const CLOSE_STYLE: CSSProperties = {
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

export type NotificationSetupAction = 'none' | 'record_subscribed' | 'offer';

/**
 * 'record_subscribed': this browser is subscribed but the saved choice does not say so.
 * 'offer': just created an agent, this browser is not subscribed, and the user has not switched notifications off.
 * A saved "off" is an explicit choice and suppresses the offer; a stale "on" does not.
 */
export function notificationSetupAction(input: {
  justCreated: boolean;
  pushEnabled: boolean;
  browserSubscribed: boolean;
  me: MeResponse | undefined;
}): NotificationSetupAction {
  if (!input.pushEnabled || !input.me) return 'none';
  const saved = input.me.notificationPreferences?.notifications?.push?.enabled;
  if (input.browserSubscribed) return saved === true ? 'none' : 'record_subscribed';
  if (!input.justCreated || saved === false) return 'none';
  return 'offer';
}

export function NotificationSetupPrompt({ justCreated }: { justCreated: boolean }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const [browser, setBrowser] = useState<PushEnvironment | null>(null);
  const recorded = useRef(false);

  const config = useQuery({
    queryKey: ['push', 'config'],
    queryFn: () => push.config(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => auth.me(),
  });

  useEffect(() => {
    let active = true;
    void readBrowserPushEnvironment().then((next) => {
      if (active) setBrowser(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const save = useMutation({
    mutationFn: (enabled: boolean) => auth.updateMe({ notificationPreferences: { notifications: { push: { enabled } } } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const action = browser === null
    ? 'none'
    : notificationSetupAction({
      justCreated,
      pushEnabled: config.data?.enabled === true,
      browserSubscribed: browser.subscribed,
      me: me.data,
    });

  useEffect(() => {
    if (action !== 'record_subscribed' || recorded.current) return;
    recorded.current = true;
    save.mutate(true);
  }, [action]);

  const choose = (enabled: boolean) => {
    setDismissed(true);
    save.mutate(enabled);
  };

  if (dismissed || action !== 'offer') return null;

  // The ✕ dismisses for this visit only and saves nothing.
  return (
    <div style={{ position: 'relative', margin: '0 0 16px' }}>
      <PushOptIn onChange={choose} />
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={intl.formatMessage({ id: 'common.dismiss' })}
        style={CLOSE_STYLE}
      >
        ✕
      </button>
    </div>
  );
}

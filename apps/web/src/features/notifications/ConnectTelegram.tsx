import { useEffect, useReducer, useRef } from 'react';
import { useIntl } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { auth as authApi } from '../../lib/api-client.js';
import { chatAddressFor } from '../../lib/chat-addresses.js';
import { Button, ErrorBanner } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { pollForTelegramLink } from './telegram-link-poll.js';
import {
  focusTargetFor,
  initialTelegramConnectState,
  parseTelegramLinkUrl,
  pollResultToAction,
  resolveConnectStatus,
  shouldCloseAbandonedTab,
  shouldPollForLink,
  shouldResetForLinked,
  telegramConnectReducer,
  type ConnectTelegramStatus,
} from './telegram-connect.js';

export type { ConnectTelegramStatus } from './telegram-connect.js';

export interface ConnectTelegramViewProps {
  status: ConnectTelegramStatus;
  /** Telegram deep link, shown as a fallback when the browser blocked the new tab. */
  linkUrl: string | null;
  errorMessage: string | null;
  onConnect: () => void;
}

const columnStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '8px' };
const statusTextStyle: React.CSSProperties = { margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-muted)', lineHeight: '1.5' };
const connectedStyle: React.CSSProperties = { ...statusTextStyle, color: 'var(--color-success)' };
const linkStyle: React.CSSProperties = { fontSize: '0.8125rem', color: 'var(--color-brand)' };

/**
 * Presentational only. The live region is always mounted so screen readers announce each change.
 * Focus moves to the status on error and to the link on fallback.
 */
export function ConnectTelegramView({ status, linkUrl, errorMessage, onConnect }: ConnectTelegramViewProps) {
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const statusRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const target = focusTargetFor(status);
    if (target === 'status') {
      statusRef.current?.focus();
    } else if (target === 'fallback') {
      fallbackRef.current?.focus();
    }
  }, [status]);

  const showLink = linkUrl !== null && (status === 'connecting' || status === 'fallback');
  const showConnect = status === 'idle' || status === 'expired' || status === 'error';

  return (
    <div style={columnStyle}>
      <div role="status" ref={statusRef} tabIndex={-1} style={{ outline: 'none' }}>
        {status === 'connecting' && <p style={statusTextStyle}>{t('settings.telegram.connecting')}</p>}
        {status === 'fallback' && <p style={statusTextStyle}>{t('settings.telegram.popupBlocked')}</p>}
        {status === 'connected' && <p style={connectedStyle}>{t('settings.telegram.connected')}</p>}
        {status === 'expired' && <p style={statusTextStyle}>{t('settings.telegram.expired')}</p>}
        {status === 'error' && <ErrorBanner message={errorMessage ?? t('settings.telegram.error')} />}
      </div>
      {showLink && (
        <a ref={fallbackRef} href={linkUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
          {t('settings.telegram.openTelegram')}
        </a>
      )}
      {showConnect && (
        <div>
          <Button variant="primary" type="button" onClick={onConnect}>
            {t('settings.telegram.connect')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Drops the pre-opened tab and closes it only if it is still blank. A navigated tab belongs to the
 * user's Telegram session, so it is left open.
 */
function releaseTab(tabRef: { current: Window | null }) {
  const tab = tabRef.current;
  tabRef.current = null;
  if (tab && shouldCloseAbandonedTab(tab)) {
    tab.close();
  }
}

/**
 * One-tap Telegram connect. Requests a single-use deep link, opens it in a new tab,
 * then polls /auth/me until the bot has bound the chat. Connected state is derived
 * from the ['me'] query, so every consumer of that query stays in sync.
 */
export function ConnectTelegram() {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me(),
  });
  const linked = chatAddressFor(meQuery.data?.chatAddresses, 'telegram') !== '';

  const [state, dispatch] = useReducer(telegramConnectReducer, initialTelegramConnectState);
  // Aborted on unmount. Each connect attempt gets a fresh signal so late callbacks from an old attempt are ignored.
  const flowRef = useRef<AbortController | null>(null);
  const tabRef = useRef<Window | null>(null);
  // Read through a ref so a locale change does not restart an in-flight poll.
  const intlRef = useRef(intl);
  useEffect(() => {
    intlRef.current = intl;
  }, [intl]);

  const linkMutation = useMutation({
    mutationFn: (returnTo: string) => authApi.linkTelegram({ returnTo }),
  });

  // Linked from outside this flow (for example by the bot during a window focus refetch): drop the stale flow.
  useEffect(() => {
    if (shouldResetForLinked(state, linked)) {
      flowRef.current?.abort();
      flowRef.current = null;
      releaseTab(tabRef);
      dispatch({ type: 'linkedExternally' });
    }
  }, [state, linked]);

  const polling = shouldPollForLink(state, linked);
  useEffect(() => {
    if (!polling) {
      return;
    }
    const controller = new AbortController();
    pollForTelegramLink({ fetchMe: (signal) => authApi.me(signal), signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) {
          return;
        }
        if (result.status === 'linked') {
          queryClient.setQueryData(['me'], result.me);
        }
        const action = pollResultToAction(result);
        if (action) {
          dispatch(action);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        dispatch({ type: 'pollFailed', message: localizeApiError(intlRef.current, error, 'settings.telegram.error') });
      });
    return () => controller.abort();
  }, [polling, queryClient]);

  // Closed on unmount by design: the flow is abandoned, so a tab that was never navigated has no purpose.
  useEffect(() => () => {
    flowRef.current?.abort();
    releaseTab(tabRef);
  }, []);

  function handleConnect() {
    flowRef.current?.abort();
    // A previous attempt's blank tab would otherwise be orphaned when tabRef is overwritten.
    releaseTab(tabRef);
    const flow = new AbortController();
    flowRef.current = flow;

    // Open the tab synchronously in the click handler. Opening it after the await
    // would be blocked by popup blockers. Cut the opener link so the t.me page cannot script this tab.
    const tab = window.open('about:blank', '_blank');
    if (tab) {
      tab.opener = null;
    }
    tabRef.current = tab;
    dispatch({ type: 'connectStarted', tabBlocked: tab === null });

    // The bot's "Return to OpenAIdom" button returns the user to this page. Relative paths only; the API checks it again.
    const returnTo = `${window.location.pathname}${window.location.search}`.slice(0, 200);
    linkMutation.mutate(returnTo, {
      onSuccess: (link) => {
        if (flow.signal.aborted) {
          return;
        }
        const url = parseTelegramLinkUrl(link.url);
        if (url === null) {
          releaseTab(tabRef);
          dispatch({ type: 'linkRejected' });
          return;
        }
        if (tab && !tab.closed) {
          tab.location.href = url;
          // The tab now belongs to the user's Telegram navigation, so this component stops tracking it.
          tabRef.current = null;
        }
        dispatch({ type: 'linkReceived', url });
      },
      onError: (error) => {
        if (flow.signal.aborted) {
          return;
        }
        releaseTab(tabRef);
        dispatch({ type: 'linkFailed', message: localizeApiError(intlRef.current, error, 'settings.telegram.error') });
      },
    });
  }

  return (
    <ConnectTelegramView
      status={resolveConnectStatus(state, linked)}
      linkUrl={state.linkUrl}
      errorMessage={state.errorMessage}
      onConnect={handleConnect}
    />
  );
}

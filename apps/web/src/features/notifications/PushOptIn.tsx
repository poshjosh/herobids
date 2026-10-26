import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { useQuery } from '@tanstack/react-query';
import { push } from '../../lib/api-client.js';
import { Button, Card, ErrorBanner } from '../../lib/ui.js';
import { createBrowserPushDeps, readBrowserPushEnvironment } from '../../lib/push/push-browser.js';
import { clearBrowserSubscription, disablePush, enablePush, PUSH_ERROR_CODES, type PushEnableOutcome } from '../../lib/push/push-subscribe-flow.js';
import { ENDPOINT_OWNED_CODE, resolvePushOptInState, type PushEnvironment, type PushOptInState } from '../../lib/push/push-opt-in-state.js';

export interface PushOptInViewProps {
  state: PushOptInState;
  busy: boolean;
  errorCode: string | null;
  onEnable: () => void;
  onDisable: () => void;
  onClearAndRetry: () => void;
  /** Renders without its own card, for use inside a parent card. */
  embedded?: boolean;
}

const headingStyle: React.CSSProperties = { margin: '0 0 12px', fontSize: '0.875rem', fontWeight: '600' };
const bodyStyle: React.CSSProperties = { margin: '0 0 16px', fontSize: '0.8125rem', color: 'var(--color-text-muted)', lineHeight: '1.5' };

function errorMessageId(errorCode: string): string {
  if (errorCode === ENDPOINT_OWNED_CODE) return 'push.optIn.endpointOwned';
  if (errorCode === PUSH_ERROR_CODES.revokeFailed) return 'push.optIn.revokeFailed';
  return 'push.optIn.error';
}

/** Presentational only. Each state is a separate render, so the copy can be tested without a browser. */
export function PushOptInView({ state, busy, errorCode, onEnable, onDisable, onClearAndRetry, embedded = false }: PushOptInViewProps) {
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });

  let body: React.ReactNode = null;
  let action: React.ReactNode = null;
  switch (state) {
    case 'ready':
      action = (
        <Button variant="primary" onClick={onEnable} disabled={busy}>
          {busy ? t('push.optIn.working') : t('push.optIn.enable')}
        </Button>
      );
      break;
    case 'subscribed':
      action = (
        <Button variant="secondary" onClick={onDisable} disabled={busy}>
          {busy ? t('push.optIn.working') : t('push.optIn.disable')}
        </Button>
      );
      break;
    case 'permission_denied':
      body = <p style={bodyStyle}>{t('push.optIn.permissionDenied')}</p>;
      break;
    case 'needs_install':
      body = (
        <>
          <p style={bodyStyle}>{t('push.optIn.needsInstall.intro')}</p>
          <ol style={{ ...bodyStyle, paddingInlineStart: '20px' }}>
            <li>{t('push.optIn.needsInstall.step1')}</li>
            <li>{t('push.optIn.needsInstall.step2')}</li>
            <li>{t('push.optIn.needsInstall.step3')}</li>
          </ol>
        </>
      );
      break;
    case 'unsupported':
      body = (
        <>
          <p style={bodyStyle}>{t('push.optIn.unsupported')}</p>
          <p style={bodyStyle}>{t('push.optIn.installHint')}</p>
        </>
      );
      break;
    case 'error':
      // Retrying cannot succeed while another account owns this browser's endpoint. The user must clear the browser's
      // subscription first, so that is offered as an explicit action instead of a plain retry.
      if (errorCode === ENDPOINT_OWNED_CODE) {
        action = (
          <Button variant="secondary" onClick={onClearAndRetry} disabled={busy}>
            {busy ? t('push.optIn.working') : t('push.optIn.clearAndRetry')}
          </Button>
        );
      } else {
        action = (
          <Button variant="primary" onClick={onEnable} disabled={busy}>
            {busy ? t('push.optIn.working') : t('push.optIn.enable')}
          </Button>
        );
      }
      break;
  }

  const content = (
    <>
      <h3 style={headingStyle}>{t('push.optIn.title')}</h3>
      {errorCode !== null && <ErrorBanner message={t(errorMessageId(errorCode))} />}
      {body}
      {action}
    </>
  );
  return embedded ? <div>{content}</div> : <Card>{content}</Card>;
}

/** Opt-in for Web Push on this device. Renders nothing when the server has the feature off. */
/** onChange reports the saved-by-user choice: true after a successful subscribe, false after turning off. */
export function PushOptIn({ onChange, embedded = false }: { onChange?: (enabled: boolean) => void; embedded?: boolean } = {}) {
  const config = useQuery({
    queryKey: ['push', 'config'],
    queryFn: () => push.config(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const [env, setEnv] = useState<PushEnvironment | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reads browser state only. Permission is never requested here (081 W8).
  useEffect(() => {
    let active = true;
    void readBrowserPushEnvironment().then((next) => {
      if (active) setEnv(next);
    });
    return () => {
      active = false;
    };
  }, []);

  async function refresh() {
    setEnv(await readBrowserPushEnvironment());
  }

  async function runAction(action: () => Promise<void>, fallbackCode: string) {
    setBusy(true);
    setErrorCode(null);
    try {
      await action();
    } catch {
      setErrorCode(fallbackCode);
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function enableAndReport(): Promise<void> {
    const outcome: PushEnableOutcome = await enablePush(createBrowserPushDeps());
    if (outcome.kind === 'subscribed') onChange?.(true);
    if (outcome.kind === 'failed') setErrorCode(outcome.code);
    if (outcome.kind === 'unavailable') setErrorCode(PUSH_ERROR_CODES.unavailable);
  }

  if (config.data?.enabled !== true || env === null) return null;

  const state = resolvePushOptInState(env, errorCode);

  return (
    <PushOptInView
      state={state}
      busy={busy}
      errorCode={errorCode}
      embedded={embedded}
      onEnable={() => void runAction(enableAndReport, PUSH_ERROR_CODES.subscribeFailed)}
      onDisable={() => void runAction(async () => {
        await disablePush(createBrowserPushDeps());
        onChange?.(false);
      }, PUSH_ERROR_CODES.revokeFailed)}
      onClearAndRetry={() => void runAction(async () => {
        await clearBrowserSubscription(createBrowserPushDeps());
        await enableAndReport();
      }, PUSH_ERROR_CODES.subscribeFailed)}
    />
  );
}

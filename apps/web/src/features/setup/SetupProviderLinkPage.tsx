import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { auth } from '../../lib/api-client.js';
import { useSession } from '../../app/providers/SessionProvider.js';
import { ProviderSetupForm, type ProviderSetupResult } from './ProviderSetupForm.js';
import { WalletCreatedStep } from './WalletCreatedStep.js';
import type { LocalizedApiError } from '../../lib/localize-api-error.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { useIntl } from 'react-intl';

type PagePhase = 'exchange' | 'form' | 'wallet' | 'done' | 'error';

export function SetupProviderLinkPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login } = useSession();
  const intl = useIntl();
  const [phase, setPhase] = useState<PagePhase>('exchange');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [setupResult, setSetupResult] = useState<ProviderSetupResult | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const code = searchParams.get('code');

    if (!code) {
      setPhase('error');
      setErrorMessage(intl.formatMessage({ id: 'auth.callback.missingCode' }));
      return;
    }

    auth.exchange(code)
      .then(({ token }) => login(token))
      .then(() => {
        setPhase('form');
      })
      .catch((err: unknown) => {
        setPhase('error');
        setErrorMessage(localizeApiError(intl, err, 'This link has expired. Use /connect in Telegram to get a new one.'));
      });
  }, [login, intl, searchParams]);

  const handleSuccess = (result: ProviderSetupResult) => {
    setSetupResult(result);
    setPhase(result.wallet ? 'wallet' : 'done');
  };

  const handleClose = () => {
    navigate('/agents', { replace: true });
  };

  if (phase === 'error') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: '400px', padding: '24px' }}>
          <div style={{ fontSize: '20px', fontWeight: '600', marginBottom: '12px', color: 'var(--color-danger)' }}>
            Link Expired
          </div>
          <div style={{ color: 'var(--color-text-secondary)', marginBottom: '24px' }}>{errorMessage}</div>
          <a href="/login" style={{ color: 'var(--color-brand)', textDecoration: 'none' }}>
            Back to Sign In
          </a>
        </div>
      </div>
    );
  }

  if (phase === 'exchange') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
          <div
            style={{
              width: '32px',
              height: '32px',
              border: '3px solid var(--color-surface-3)',
              borderTopColor: 'var(--color-brand)',
              borderRadius: '50%',
              animation: 'spin 0.7s linear infinite',
            }}
          />
          <div style={{ color: 'var(--color-text-secondary)' }}>Opening setup form...</div>
        </div>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: '460px', padding: '24px' }}>
          <div style={{ fontSize: '20px', fontWeight: '600', marginBottom: '12px', color: 'var(--color-success)' }}>
            Connected!
          </div>
          <div style={{ color: 'var(--color-text-secondary)', marginBottom: '24px', lineHeight: '1.6' }}>
            Return to Telegram and use /connections to see your new connection, then /connect &lt;agent&gt; &lt;id&gt; to assign it.
          </div>
          <button
            onClick={() => navigate('/agents', { replace: true })}
            style={{
              background: 'var(--color-brand)',
              color: '#fff',
              border: 'none',
              padding: '10px 24px',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: '500',
            }}
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'wallet' && setupResult?.wallet) {
    return <WalletCreatedStep wallet={setupResult.wallet} onContinue={() => setPhase('done')} />;
  }

  return (
    <ProviderSetupForm
      standalone
      defaultCapability="trading"
      onClose={handleClose}
      onSuccess={handleSuccess}
    />
  );
}

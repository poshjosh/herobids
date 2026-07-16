import { useState } from 'react';
import type { ProviderSetupResult } from '../../lib/api-client.js';
import { Button, Modal, inputStyle } from '../../lib/ui.js';

interface Props {
  wallet: NonNullable<ProviderSetupResult['wallet']>;
  onContinue: () => void;
}

function fundingGuidance(wallet: NonNullable<ProviderSetupResult['wallet']>): string {
  if (wallet.fundingInstructionId === 'solana-mainnet') {
    return 'Fund this wallet with SOL on Solana mainnet before trading.';
  }
  if (wallet.fundingInstructionId === 'hyperliquid-mainnet') {
    return 'Fund this wallet on Hyperliquid mainnet before trading.';
  }
  return `Fund this wallet on ${wallet.network} before trading.`;
}

export function WalletCreatedStep({ wallet, onContinue }: Props) {
  const [copied, setCopied] = useState(false);

  const copyAddress = async () => {
    await navigator.clipboard.writeText(wallet.address);
    setCopied(true);
  };

  return (
    <Modal title="Wallet created" onClose={onContinue}>
      <p style={{ marginTop: 0, color: 'var(--color-text-secondary)' }}>
        OpenAIdom holds this generated direct-wallet signing key encrypted on your behalf.
      </p>
      <label style={{ display: 'block', marginBottom: '8px', fontWeight: 600 }}>Funding address</label>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <input readOnly value={wallet.address} style={{ ...inputStyle, fontFamily: 'monospace', minWidth: 0 }} />
        <Button type="button" variant="secondary" onClick={() => void copyAddress()}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{fundingGuidance(wallet)}</p>
      <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>Trading starts only after the wallet is funded. Deposits are not bridged or confirmed automatically.</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="button" variant="primary" onClick={onContinue}>Continue</Button>
      </div>
    </Modal>
  );
}
import { useState } from 'react';
import type { ChatMessage, ProviderSetupResult } from '../../lib/api-client.js';
import { ChatQuickReplies } from './ChatQuickReplies.js';
import { ProviderSetupForm } from '../setup/ProviderSetupForm.js';
import { saveGuidedSetupOAuthDraft } from './guidedSetupOAuthDraft.js';

/**
 * Resolve a funding docs deep-link URL from a fundingInstructionId and provider name.
 * Uses prefix matching for 1inch (ID is dynamic: 1inch-8453, 1inch-42161, etc.).
 */
function resolveFundingDocUrl(fundingId: string, provider: string): string {
  const BASE = '/docs/trading-venues/funding-wallets';
  if (fundingId === 'hyperliquid-mainnet') return `${BASE}#hyperliquid`;
  if (fundingId === 'solana-mainnet') return `${BASE}#jupiter`;
  if (fundingId.startsWith('1inch-') || provider === '1inch') return `${BASE}#1inch`;
  return BASE;
}

interface GuidedSetupActionRendererProps {
  actions: NonNullable<ChatMessage['actions']>;
  onQuickReply: (value: string) => void;
  /** Called when an inline form (e.g. connection setup) completes successfully. */
  onFormSubmit: (actionId: string, result: unknown) => void;
  /** Current thread id, used to build the OAuth return URL for provider redirects. */
  threadId?: string;
  disabled?: boolean;
  /** When true, suppress rendering of form-type actions. */
  hideForms?: boolean;
}

/**
 * Renders structured chat actions inline within the message stream.
 *
 * Supported action types:
 * - quick_replies: Button row for preset/suggestion selection
 * - form: Secure setup UI rendered inline (connection, wallet, etc.)
 * - confirm: Agent creation confirmation card
 */
export function GuidedSetupActionRenderer({ actions, onQuickReply, onFormSubmit, threadId, disabled = false, hideForms = false }: GuidedSetupActionRendererProps) {
  // Track locally dismissed form action IDs so the form disappears instantly
  // on cancel, before the API round-trip completes. This also prevents
  // double-clicks since there is no longer a visible target.
  const [dismissedActionIds, setDismissedActionIds] = useState<Set<string>>(new Set());

  return (
    <div style={{ marginTop: 8 }}>
      {actions.map((action) => {
        switch (action.type) {
          case 'quick_replies':
            return (
              <ChatQuickReplies
                key={action.id}
                options={action.options ?? []}
                onSelect={onQuickReply}
                disabled={disabled}
              />
            );

          case 'confirm': {
            const confirmProps = (action.props ?? {}) as Record<string, unknown>;
            // Wallet-created card: show funding guidance prominently
            if (confirmProps.type === 'wallet_created') {
              const providerName = String(confirmProps.provider ?? '');
              const displayName = providerName === 'hyperliquid' ? 'Hyperliquid'
                : providerName === 'jupiter' ? 'Jupiter'
                : providerName === '1inch' ? '1inch'
                : providerName;
              const walletAddress = String(confirmProps.walletAddress ?? '');
              const network = String(confirmProps.network ?? '');
              const fundingId = String(confirmProps.fundingInstructionId ?? '');

              const fundingInstructionText = fundingId === 'hyperliquid-mainnet'
                ? `Fund this wallet by sending USDC to the address on ${network}.`
                : fundingId === 'solana-mainnet'
                  ? `Fund this wallet by sending SOL or USDC to the address on Solana.`
                  : `Fund this wallet by sending tokens to the address on ${network}.`;

              return (
                <div
                  key={action.id}
                  style={{
                    padding: '16px',
                    borderRadius: 8,
                    backgroundColor: 'var(--color-success-bg, #e6f7ed)',
                    border: '1px solid var(--color-success, #2da44e)',
                    fontSize: '0.875rem',
                    color: 'var(--color-text)',
                    marginTop: 8,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>
                    ✅ {displayName} wallet created
                  </div>
                  <div style={{
                    fontFamily: 'monospace',
                    fontSize: '0.75rem',
                    padding: '8px',
                    backgroundColor: 'var(--color-surface-1, #f6f8fa)',
                    borderRadius: 4,
                    wordBreak: 'break-all',
                    marginBottom: 8,
                  }}>
                    {walletAddress}
                  </div>
                  <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                    Network: {network}
                  </div>
                  <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
                    {fundingInstructionText}
                  </div>
                  <a
                    href={resolveFundingDocUrl(fundingId, providerName)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '0.8125rem', color: 'var(--color-primary)', marginTop: 8, display: 'inline-block' }}
                  >
                    Learn more about funding {displayName} wallets →
                  </a>
                </div>
              );
            }
            return (
              <div
                key={action.id}
                style={{
                  padding: '12px 16px',
                  borderRadius: 8,
                  backgroundColor: 'var(--color-success-bg, #e6f7ed)',
                  border: '1px solid var(--color-success, #2da44e)',
                  fontSize: '0.875rem',
                  color: 'var(--color-text)',
                }}
              >
                {'message' in confirmProps
                  ? String(confirmProps.message)
                  : '✓ Confirmed'}
              </div>
            );
          }

          case 'form':
            if (hideForms) return null;
            if (dismissedActionIds.has(action.id)) return null;
            if (action.form === 'connection') {
              const props = (action.props ?? {}) as Record<string, unknown>;
              const preferredCapability = props.preferredCapability === 'trading' || props.preferredCapability === 'email' || props.preferredCapability === 'other'
                ? props.preferredCapability
                : undefined;
              const preferredProvider = typeof props.preferredProvider === 'string' ? props.preferredProvider : undefined;
              const oauthReturnTo = threadId
                ? `/agents/new?guided=1&oauthReturn=1&threadId=${encodeURIComponent(threadId)}&actionId=${encodeURIComponent(action.id)}`
                : undefined;

              return (
                <div
                  key={action.id}
                  style={{
                    padding: '12px 16px',
                    borderRadius: 8,
                    backgroundColor: 'var(--color-surface-2)',
                    border: '1px solid var(--color-border)',
                    marginTop: 8,
                  }}
                >
                  <ProviderSetupForm
                    inline
                    defaultCapability={preferredCapability ?? 'trading'}
                    initialProviderId={preferredProvider}
                    oauthReturnTo={oauthReturnTo}
                    onBeforeOAuthRedirect={() => {
                      if (threadId) {
                        saveGuidedSetupOAuthDraft({ threadId, actionId: action.id });
                      }
                    }}
                    onClose={() => {
                      // Dismiss the form instantly so the user sees immediate
                      // feedback and cannot double-click. The cancellation
                      // signal is still sent to the backend asynchronously.
                      setDismissedActionIds((prev) => new Set(prev).add(action.id));
                      onFormSubmit(action.id, { cancelled: true });
                    }}
                    onSuccess={(result: ProviderSetupResult) => {
                      setDismissedActionIds((prev) => new Set(prev).add(action.id));
                      onFormSubmit(action.id, { connectionId: result.connection.id });
                    }}
                  />
                </div>
              );
            }
            return (
              <div
                key={action.id}
                style={{
                  padding: '12px 16px',
                  borderRadius: 8,
                  backgroundColor: 'var(--color-surface-2)',
                  border: '1px solid var(--color-border)',
                  fontSize: '0.875rem',
                  color: 'var(--color-text-muted)',
                }}
              >
                {`📋 Form: ${action.form ?? 'unknown'}`}
              </div>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}

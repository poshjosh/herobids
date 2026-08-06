import type { ChatMessage, ProviderSetupResult } from '../../lib/api-client.js';
import { ChatQuickReplies } from './ChatQuickReplies.js';
import { ProviderSetupForm } from '../setup/ProviderSetupForm.js';
import { saveGuidedSetupOAuthDraft } from './guidedSetupOAuthDraft.js';

interface GuidedSetupActionRendererProps {
  actions: NonNullable<ChatMessage['actions']>;
  onQuickReply: (value: string) => void;
  /** Called when an inline form (e.g. connection setup) completes successfully. */
  onFormSubmit: (actionId: string, result: unknown) => void;
  /** Current thread id, used to build the OAuth return URL for provider redirects. */
  threadId?: string;
  disabled?: boolean;
}

/**
 * Renders structured chat actions inline within the message stream.
 *
 * Supported action types:
 * - quick_replies: Button row for preset/suggestion selection
 * - form: Secure setup UI rendered inline (connection, wallet, etc.)
 * - confirm: Agent creation confirmation card
 */
export function GuidedSetupActionRenderer({ actions, onQuickReply, onFormSubmit, threadId, disabled = false }: GuidedSetupActionRendererProps) {
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

          case 'confirm':
            return (
              <div
                key={action.id}
                style={{
                  padding: '12px 16px',
                  borderRadius: 8,
                  backgroundColor: 'var(--color-success-bg, #e6f7ed)',
                  border: '1px solid var(--color-success, #2da44e)',
                  fontSize: 14,
                  color: 'var(--color-text)',
                }}
              >
                {action.props && typeof action.props === 'object' && 'message' in action.props
                  ? String(action.props.message)
                  : '✓ Confirmed'}
              </div>
            );

          case 'form':
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
                      // User dismissed the inline form — send a cancel signal
                      onFormSubmit(action.id, { cancelled: true });
                    }}
                    onSuccess={(result: ProviderSetupResult) => {
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
                  fontSize: 14,
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

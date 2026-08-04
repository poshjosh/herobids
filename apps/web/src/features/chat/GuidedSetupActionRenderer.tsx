import type { ChatMessage } from '../../lib/api-client.js';
import { ChatQuickReplies } from './ChatQuickReplies.js';

interface GuidedSetupActionRendererProps {
  actions: NonNullable<ChatMessage['actions']>;
  onQuickReply: (value: string) => void;
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
export function GuidedSetupActionRenderer({ actions, onQuickReply, disabled = false }: GuidedSetupActionRendererProps) {
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
                {action.form === 'connection'
                  ? '🔗 Secure connection form — use the setup UI to connect your account.'
                  : `📋 Form: ${action.form ?? 'unknown'}`}
              </div>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}

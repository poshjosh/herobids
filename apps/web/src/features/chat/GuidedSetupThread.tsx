import { useRef, useEffect } from 'react';
import type { ChatMessage as ChatMessageType } from '../../lib/api-client.js';
import { ChatMessage } from './ChatMessage.js';
import { ChatComposer } from './ChatComposer.js';
import { GuidedSetupActionRenderer } from './GuidedSetupActionRenderer.js';

interface GuidedSetupThreadProps {
  messages: ChatMessageType[];
  onSend: (content: string) => void;
  onQuickReply: (value: string) => void;
  onFormSubmit: (actionId: string, result: unknown) => void;
  threadId?: string;
  sending: boolean;
  disabled?: boolean;
  /** When true, suppress rendering of form-type actions (e.g. during OAuth resume). */
  hideForms?: boolean;
  /** When true, show an inline assistant-style status bubble in the thread (e.g. OAuth resume). */
  oauthResuming?: boolean;
}

export function GuidedSetupThread({ messages, onSend, onQuickReply, onFormSubmit, threadId, sending, disabled = false, hideForms = false, oauthResuming = false }: GuidedSetupThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the message list to the bottom when new messages arrive.
  // We scroll the internal list container directly (scrollTop) rather than
  // using scrollIntoView, which would also scroll the whole page and make the
  // composer appear to jump.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {/* Message list */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '16px',
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              height: '100%',
              color: 'var(--color-text-muted)',
              fontSize: 14,
            }}
          >
            Starting conversation...
          </div>
        )}

        {messages.map((msg) => {
          const hasActions = msg.actions && msg.actions.length > 0;

          return (
            <div key={msg.id}>
              <ChatMessage message={msg} />
              {hasActions && (
                <GuidedSetupActionRenderer
                  actions={msg.actions!}
                  onQuickReply={onQuickReply}
                  onFormSubmit={onFormSubmit}
                  threadId={threadId}
                  disabled={disabled || sending}
                  hideForms={hideForms}
                />
              )}
            </div>
          );
        })}

        {/* OAuth resume indicator — inline assistant-style bubble so the user
            sees the status where they're already looking (the message thread). */}
        {oauthResuming && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              marginBottom: 16,
            }}
          >
            <div
              style={{
                maxWidth: '80%',
                padding: '12px 18px',
                borderRadius: 12,
                backgroundColor: 'var(--color-surface-2)',
                color: 'var(--color-text)',
                fontSize: 15,
                lineHeight: 1.5,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
                <span style={{ animation: 'pulse 1.5s infinite', color: 'var(--color-primary)' }}>●</span>
                Processing your connection…
              </span>
              <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                One moment while we complete the setup.
              </span>
            </div>
          </div>
        )}

        {/* Sending indicator */}
        {sending && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', color: 'var(--color-text-muted)', fontSize: 13 }}>
            <span style={{ animation: 'pulse 1.5s infinite' }}>●</span>
            Assistant is thinking...
          </div>
        )}
      </div>

      {/* Composer */}
      <ChatComposer
        onSend={onSend}
        disabled={disabled || sending}
        placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
      />
    </div>
  );
}

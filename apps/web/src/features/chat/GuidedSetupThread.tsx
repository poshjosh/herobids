import { useRef, useEffect } from 'react';
import type { ChatMessage } from '../../lib/api-client.js';
import { ChatMessage } from './ChatMessage.js';
import { ChatComposer } from './ChatComposer.js';
import { GuidedSetupActionRenderer } from './GuidedSetupActionRenderer.js';

interface GuidedSetupThreadProps {
  messages: ChatMessage[];
  onSend: (content: string) => void;
  onQuickReply: (value: string) => void;
  sending: boolean;
  disabled?: boolean;
}

export function GuidedSetupThread({ messages, onSend, onQuickReply, sending, disabled = false }: GuidedSetupThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Message list */}
      <div
        style={{
          flex: 1,
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

        {messages.map((msg, idx) => {
          const isLastAssistant = msg.role === 'assistant' && idx === messages.length - 1;
          const hasActions = msg.actions && msg.actions.length > 0;

          return (
            <div key={msg.id}>
              <ChatMessage message={msg} />
              {hasActions && (
                <GuidedSetupActionRenderer
                  actions={msg.actions!}
                  onQuickReply={onQuickReply}
                  disabled={disabled || sending}
                />
              )}
              {/* Show "Use the form instead" link after the first greeting */}
              {isLastAssistant && idx === 0 && (
                <div style={{ padding: '0 16px 16px', fontSize: 12, color: 'var(--color-text-muted)' }}>
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      // The parent handles switching to form
                      onQuickReply('action:use_form');
                    }}
                    style={{ color: 'var(--color-text-muted)', textDecoration: 'underline' }}
                  >
                    Use the form instead
                  </a>
                </div>
              )}
            </div>
          );
        })}

        {/* Sending indicator */}
        {sending && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', color: 'var(--color-text-muted)', fontSize: 13 }}>
            <span style={{ animation: 'pulse 1.5s infinite' }}>●</span>
            Guided Setup is thinking...
          </div>
        )}

        <div ref={bottomRef} />
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

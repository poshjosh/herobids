import type { ChatMessage } from '../../lib/api-client.js';

interface ChatMessageProps {
  message: ChatMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 16,
      }}
    >
      <div
        style={{
          maxWidth: '80%',
          padding: '10px 16px',
          borderRadius: 12,
          backgroundColor: isUser ? 'var(--color-primary)' : 'var(--color-surface-2)',
          color: isUser ? 'var(--color-on-primary)' : 'var(--color-text)',
          fontSize: 15,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {message.content}
      </div>
      <span
        style={{
          fontSize: 11,
          color: 'var(--color-text-muted)',
          marginTop: 4,
          paddingInline: 4,
        }}
      >
        {isUser ? 'You' : 'Guided Setup'}
      </span>
    </div>
  );
}

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
          wordBreak: 'break-word',
        }}
      >
        {isUser ? (
          <span style={{ whiteSpace: 'pre-wrap' }}>{message.content}</span>
        ) : (
          <div className="prose prose-invert" style={{ maxWidth: 'none' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

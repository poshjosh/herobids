import { useState, useRef, useEffect, type KeyboardEvent } from 'react';

interface ChatComposerProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatComposer({ onSend, disabled = false, placeholder = 'Type your message...' }: ChatComposerProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!disabled && inputRef.current) {
      inputRef.current.focus();
    }
  }, [disabled]);

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '12px 16px',
        borderTop: '1px solid var(--color-border)',
        backgroundColor: 'var(--color-surface-1)',
      }}
    >
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        style={{
          flex: 1,
          resize: 'none',
          padding: '10px 14px',
          borderRadius: 8,
          border: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-surface-2)',
          color: 'var(--color-text)',
          fontSize: 15,
          lineHeight: 1.4,
          fontFamily: 'inherit',
          outline: 'none',
          maxHeight: 120,
        }}
      />
      <button
        onClick={handleSend}
        disabled={disabled || !value.trim()}
        style={{
          padding: '10px 20px',
          borderRadius: 8,
          border: 'none',
          backgroundColor: disabled || !value.trim() ? 'var(--color-surface-2)' : 'var(--color-primary)',
          color: disabled || !value.trim() ? 'var(--color-text-muted)' : 'var(--color-on-primary)',
          fontSize: 15,
          fontWeight: 600,
          cursor: disabled || !value.trim() ? 'not-allowed' : 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {disabled ? '...' : 'Send'}
      </button>
    </div>
  );
}

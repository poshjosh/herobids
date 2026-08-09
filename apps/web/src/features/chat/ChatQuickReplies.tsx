interface QuickReplyOption {
  label: string;
  value: string;
}

interface ChatQuickRepliesProps {
  options: QuickReplyOption[];
  onSelect: (value: string) => void;
  disabled?: boolean;
}

export function ChatQuickReplies({ options, onSelect, disabled = false }: ChatQuickRepliesProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        padding: '8px 16px 16px',
      }}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onSelect(opt.value)}
          disabled={disabled}
          style={{
            padding: '8px 16px',
            borderRadius: 20,
            border: '1px solid var(--color-primary)',
            backgroundColor: 'transparent',
            color: 'var(--color-primary)',
            fontSize: '0.875rem',
            fontWeight: 500,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            transition: 'background-color 0.15s',
          }}
          onMouseEnter={(e) => {
            if (!disabled) (e.target as HTMLButtonElement).style.backgroundColor = 'var(--color-primary)';
            if (!disabled) (e.target as HTMLButtonElement).style.color = 'var(--color-on-primary)';
          }}
          onMouseLeave={(e) => {
            (e.target as HTMLButtonElement).style.backgroundColor = 'transparent';
            (e.target as HTMLButtonElement).style.color = 'var(--color-primary)';
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

import { useId, useRef } from 'react';
import { Button, FieldLabel } from '../../lib/ui.js';

interface AgentDocumentPickerProps {
  files: File[];
  onChange: (files: File[]) => void;
  title?: string;
  helperText?: string;
}

export function AgentDocumentPicker({
  files,
  onChange,
  title = 'Documents (Optional)',
  helperText = 'PDFs, DOCX, TEXT files for your agent to work with.',
}: AgentDocumentPickerProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
      <FieldLabel>{title}</FieldLabel>

      <input
        id={inputId}
        ref={inputRef}
        type="file"
        multiple
        accept=".txt,.md,.csv,.html,.xml,.json,.pdf,.docx"
        onChange={(e) => {
          onChange(Array.from(e.target.files ?? []));
        }}
        style={{ display: 'none' }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <Button variant="secondary" type="button" onClick={() => inputRef.current?.click()}>
          Choose files
        </Button>
        <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          {files.length === 0 ? 'No files selected' : `${files.length} file${files.length === 1 ? '' : 's'} selected`}
        </span>
      </div>

      <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', margin: 0 }}>
        {helperText}
      </p>

      {files.length > 0 && (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {files.map((file) => (
            <li
              key={`${file.name}:${file.size}:${file.lastModified}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 10px',
                border: '1px solid var(--color-border)',
                borderRadius: '8px',
                background: 'var(--color-surface-2)',
                fontSize: '13px',
                color: 'var(--color-text-secondary)',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {file.name}
              </span>
              <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', flexShrink: 0 }}>
                ({(file.size / 1024).toFixed(0)} KB)
              </span>
              <button
                type="button"
                onClick={() => {
                  onChange(files.filter((candidate) => candidate !== file));
                  if (inputRef.current) {
                    inputRef.current.value = '';
                  }
                }}
                style={{
                  color: 'var(--color-danger)',
                  fontSize: '12px',
                  marginLeft: 'auto',
                  flexShrink: 0,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
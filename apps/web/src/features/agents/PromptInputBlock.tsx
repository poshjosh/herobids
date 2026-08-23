import { useId, useRef, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import type { AgentStyleValue } from './style-mapping.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PromptInputBlockProps {
  // Goal / prompt
  goal: string;
  onGoalChange: (goal: string) => void;
  onGoalBlur?: () => void;
  goalPlaceholder: string;
  goalLabel: ReactNode;
  goalError?: string;
  required?: boolean;
  /** data-field attribute value for scroll-to-error (e.g. "goal") */
  dataField?: string;

  // Pending (not yet uploaded) files
  pendingFiles: File[];
  onPendingFilesChange: (files: File[]) => void;

  // Existing server-side documents (edit mode only)
  existingDocs?: Array<{
    id: string;
    originalFilename: string;
    extractionStatus: string;
  }>;
  /** Called when the user removes an existing (already-saved) document */
  onDeleteExistingDoc?: (docId: string) => void;

  // Agent style
  style: AgentStyleValue;
  onStyleChange: (style: AgentStyleValue) => void;
}

// ─── Style helpers ──────────────────────────────────────────────────────────

const STYLE_OPTIONS: Array<{ value: AgentStyleValue; labelKey: string }> = [
  { value: 'careful', labelKey: 'agents.style.careful.label' },
  { value: 'balanced', labelKey: 'agents.style.balanced.label' },
  { value: 'bold', labelKey: 'agents.style.bold.label' },
];

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Unified prompt input block — textarea with a seamless bottom bar
 * containing file chips, a paper-clip upload button, and a compact
 * agent-style selector. Zero internal gaps between the three surfaces.
 */
export function PromptInputBlock({
  goal,
  onGoalChange,
  onGoalBlur,
  goalPlaceholder,
  goalLabel,
  goalError,
  required,
  dataField,
  pendingFiles,
  onPendingFilesChange,
  existingDocs,
  onDeleteExistingDoc,
  style,
  onStyleChange,
}: PromptInputBlockProps) {
  const intl = useIntl();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div data-field={dataField} style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '4px' }}>
      {/* Label */}
      <label style={{ fontSize: '0.8125rem', fontWeight: '600', color: 'var(--color-text-primary)', marginBottom: '2px', letterSpacing: '0.02em' }}>
        {goalLabel}
      </label>

      {/* ── Unified block: textarea + bottom bar ── */}
      <div
        style={{
          border: `1.5px solid ${goalError ? 'var(--color-danger)' : 'var(--input-border-color)'}`,
          borderRadius: '10px',
          background: 'var(--color-surface-3)',
          overflow: 'hidden',
          transition: 'border-color 0.15s, box-shadow 0.15s',
        }}
      >
        {/* Textarea — no internal border, fully seamless */}
        <textarea
          style={{
            width: '100%',
            minHeight: '96px',
            padding: '12px 14px',
            background: 'transparent',
            border: 'none',
            borderRadius: 0,
            color: 'var(--color-text-primary)',
            fontSize: '1rem',
            outline: 'none',
            resize: 'vertical',
            overflow: 'hidden',
            boxSizing: 'border-box',
            fontFamily: 'inherit',
            lineHeight: '1.6',
          }}
          value={goal}
          onChange={(e) => onGoalChange(e.target.value)}
          onBlur={onGoalBlur}
          placeholder={goalPlaceholder}
          required={required}
        />

        {/* ── Bottom bar ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '6px 12px',
            borderTop: '1px solid var(--color-border-subtle)',
            minHeight: '36px',
          }}
        >
          {/* File chips (left) */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              overflow: 'hidden',
              flexWrap: 'wrap',
            }}
          >
            {/* Existing (server-side) docs — edit mode */}
            {Array.isArray(existingDocs) && existingDocs.map((doc) => (
              <span
                key={doc.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '3px',
                  fontSize: '0.75rem',
                  color: 'var(--color-text-secondary)',
                  background: 'var(--color-surface-3)',
                  padding: '2px 7px',
                  borderRadius: '4px',
                  maxWidth: '180px',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {doc.originalFilename}
                </span>
                {onDeleteExistingDoc && (
                  <button
                    type="button"
                    onClick={() => onDeleteExistingDoc(doc.id)}
                    style={{
                      cursor: 'pointer',
                      background: 'none',
                      border: 'none',
                      color: 'var(--color-text-muted)',
                      fontSize: '0.8125rem',
                      padding: 0,
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {pendingFiles.map((file) => (
              <span
                key={`${file.name}:${file.size}:${file.lastModified}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '3px',
                  fontSize: '0.75rem',
                  color: 'var(--color-text-secondary)',
                  background: 'var(--color-surface-3)',
                  padding: '2px 7px',
                  borderRadius: '4px',
                  maxWidth: '180px',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {file.name}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onPendingFilesChange(pendingFiles.filter((f) => f !== file))
                  }
                  style={{
                    cursor: 'pointer',
                    background: 'none',
                    border: 'none',
                    color: 'var(--color-text-muted)',
                    fontSize: '0.8125rem',
                    padding: 0,
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          {/* Hidden file input (triggered by paper-clip) */}
          <input
            id={fileInputId}
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.csv,.html,.xml,.json,.pdf,.docx"
            onChange={(e) =>
              onPendingFilesChange(Array.from(e.target.files ?? []))
            }
            style={{ display: 'none' }}
          />

          {/* Paper-clip button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title={intl.formatMessage({
              id: 'agents.create.attachFiles',
              defaultMessage: 'Attach files',
            })}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '1.125rem',
              padding: '4px 8px',
              color:
                pendingFiles.length > 0
                  ? 'var(--color-brand)'
                  : 'var(--color-text-muted)',
              borderRadius: '4px',
              lineHeight: 1,
              transition: 'color 0.15s',
            }}
          >
            📎
          </button>

          {/* Compact style selector — no border, blends into bar */}
          <select
            value={style}
            onChange={(e) => onStyleChange(e.target.value as AgentStyleValue)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--color-text-primary)',
              fontSize: '0.8125rem',
              padding: '4px 6px',
              cursor: 'pointer',
              outline: 'none',
              fontWeight: 500,
              fontFamily: 'inherit',
            }}
          >
            {STYLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {intl.formatMessage({ id: opt.labelKey })}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Error message */}
      {goalError && (
        <div
          style={{
            color: 'var(--color-danger)',
            fontSize: '0.75rem',
            marginTop: '2px',
          }}
        >
          {goalError}
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { blueprints, type BlueprintDetail } from '../../lib/api-client.js';
import { Modal, Button, ErrorBanner, inputStyle, SectionLabel } from '../../lib/ui.js';

interface BlueprintEditModalProps {
  blueprint: BlueprintDetail;
  onClose: () => void;
  /** Called after a successful edit with the updated detail. */
  onEdited?: (updated: BlueprintDetail) => void;
}

/**
 * Modal for editing a blueprint's payload, creating a new revision.
 *
 * Editable fields vary by kind:
 * - agent: name, description, tags, prompt, style, strategy, risk, executionDefaults, etc.
 * - bot: name, description, tags, strategy, risk, executionDefaults, venue, symbol, etc.
 *
 * For Phase 1, we expose a simplified text-based editor for the payload JSON
 * so users can edit any field. A richer form editor can be added later.
 */
export function BlueprintEditModal({ blueprint, onClose, onEdited }: BlueprintEditModalProps) {
  const payload = blueprint.revision.payload;
  const [payloadText, setPayloadText] = useState(() =>
    JSON.stringify(payload, null, 2),
  );
  const [changeSummary, setChangeSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const editMutation = useMutation({
    mutationFn: async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payloadText) as Record<string, unknown>;
      } catch {
        throw new Error('Invalid JSON in payload editor');
      }

      return blueprints.createRevision(blueprint.id, {
        payload: parsed,
        changeSummary: changeSummary || null,
        expectedBaseRevisionId: blueprint.currentRevisionId,
      });
    },
    onSuccess: (data) => {
      onEdited?.(data);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handlePayloadChange = (value: string) => {
    setPayloadText(value);
    try {
      JSON.parse(value);
      setParseError(null);
    } catch (e) {
      setParseError((e as Error).message);
    }
  };

  const handleSubmit = () => {
    if (parseError) {
      setError('Fix JSON errors before saving');
      return;
    }
    setError(null);
    editMutation.mutate();
  };

  const isPublished = blueprint.publicationStatus === 'published';
  const hasStagedEdits = blueprint.currentRevisionId !== blueprint.publishedRevisionId;

  return (
    <Modal
      title={`Edit: ${blueprint.name}`}
      onClose={onClose}
      placement="top"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: '560px', maxWidth: '700px' }}>
        {error && <ErrorBanner message={error} />}

        {/* Status badges */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '2px 8px',
            borderRadius: '12px',
            background: isPublished ? 'var(--color-success-bg, #e6f4ea)' : 'var(--color-surface-2)',
            fontSize: '11px',
            fontWeight: '500',
            color: isPublished ? 'var(--color-success, #1e7e34)' : 'var(--color-text-secondary)',
          }}>
            {blueprint.publicationStatus}
          </span>
          {hasStagedEdits && (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 8px',
              borderRadius: '12px',
              background: 'var(--color-warning-bg, #fff3cd)',
              fontSize: '11px',
              fontWeight: '500',
              color: 'var(--color-warning, #856404)',
            }}>
              Staged edits
            </span>
          )}
        </div>

        {isPublished && !hasStagedEdits && (
          <div style={{
            fontSize: '12px',
            color: 'var(--color-text-muted)',
            background: 'var(--color-surface-1)',
            padding: '8px 12px',
            borderRadius: '6px',
          }}>
            Editing a published blueprint creates a new authoring revision.
            The public listing will continue to show the published revision until you publish again.
          </div>
        )}

        <SectionLabel>Change Summary (optional)</SectionLabel>
        <input
          value={changeSummary}
          onChange={(e) => setChangeSummary(e.target.value)}
          style={inputStyle}
          placeholder="Brief summary of changes in this revision"
        />

        <SectionLabel>Payload ({blueprint.kind})</SectionLabel>
        {parseError && (
          <div style={{ color: 'var(--color-danger, #dc3545)', fontSize: '12px' }}>
            JSON error: {parseError}
          </div>
        )}
        <textarea
          value={payloadText}
          onChange={(e) => handlePayloadChange(e.target.value)}
          style={{
            ...inputStyle,
            minHeight: '300px',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: '12px',
            lineHeight: '1.5',
            resize: 'vertical',
          }}
          spellCheck={false}
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!!parseError || editMutation.isPending}
          >
            {editMutation.isPending ? 'Saving...' : 'Save Revision'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { blueprints } from '../../lib/api-client.js';
import { Modal, Button, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';

interface SaveAsBlueprintModalProps {
  /** 'agent' or 'bot' */
  actorKind: 'agent' | 'bot';
  /** The agent or bot ID to save as blueprint. */
  actorId: string;
  /** Current name of the actor, used as default blueprint name. */
  actorName: string;
  onClose: () => void;
  /** Called with the created blueprint ID on success. */
  onCreated?: (blueprintId: string) => void;
}

export function SaveAsBlueprintModal({
  actorKind,
  actorId,
  actorName,
  onClose,
  onCreated,
}: SaveAsBlueprintModalProps) {
  const [name, setName] = useState(actorName);
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [blueprintId, setBlueprintId] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async () => {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      if (actorKind === 'agent') {
        return blueprints.createFromAgent(actorId, { name, description, tags });
      }
      return blueprints.createFromBot(actorId, { name, description, tags });
    },
    onSuccess: (data) => {
      setBlueprintId(data.id);
      onCreated?.(data.id);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handleSubmit = () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setError(null);
    createMutation.mutate();
  };

  if (blueprintId) {
    return (
      <Modal title="Blueprint created!" onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ fontSize: '14px', color: 'var(--color-text-secondary)' }}>
            Your {actorKind} <strong>{actorName}</strong> has been saved as a draft blueprint.
          </div>
          <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
            Blueprint ID: {blueprintId}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Save ${actorKind === 'agent' ? 'Agent' : 'Bot'} as Blueprint`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: '400px' }}>
        {error && <ErrorBanner message={error} />}

        <FieldLabel>Name</FieldLabel>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={inputStyle}
          placeholder="Blueprint name"
        />

        <FieldLabel>Description</FieldLabel>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ ...inputStyle, minHeight: '80px', resize: 'vertical' }}
          placeholder="Brief description of this blueprint"
        />

        <FieldLabel>Tags (comma-separated)</FieldLabel>
        <input
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          style={inputStyle}
          placeholder="e.g. momentum, trading, beginner"
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? 'Saving...' : 'Save as Blueprint'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

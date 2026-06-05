import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button, StatusBadge, RelativeTime, KV, Modal, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';

export function AgentsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });

  const items = query.data ?? [];

  return (
    <PageShell>
      <PageHeader
        title="AI Agents"
        subtitle="Autonomous trading agents linked to your instances"
        action={<Button variant="primary" onClick={() => setShowCreate(true)}>New Agent</Button>}
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No agents yet"
          message="Create an AI agent to autonomously trade on a linked instance."
          action={<Button variant="primary" onClick={() => setShowCreate(true)}>Create Agent</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {items.map((agent) => (
            <Card key={agent.id}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
                <div
                  style={{ flex: 1, cursor: 'pointer' }}
                  onClick={() => navigate(`/agents/${agent.id}`)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                    <span style={{ fontWeight: '600', fontSize: '15px' }}>{agent.name}</span>
                    <StatusBadge status={agent.status} />
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--color-text-muted)', marginBottom: '8px' }}>
                    {agent.prompt}
                  </div>
                  <div style={{ display: 'flex', gap: '24px' }}>
                    <KV label="Created" value={<RelativeTime timestamp={agent.createdAt} />} />
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateAgentModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void qc.invalidateQueries({ queryKey: ['agents'] });
          }}
        />
      )}
    </PageShell>
  );
}

function CreateAgentModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');

  const mutation = useMutation({
    mutationFn: () => agentsApi.create({ name, prompt }),
    onSuccess: onCreated,
  });

  return (
    <Modal title="Create Agent" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {mutation.isError && <ErrorBanner message={(mutation.error as Error).message} />}

        <div>
          <FieldLabel>Name</FieldLabel>
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="My BTC Agent" required />
        </div>

        <div>
          <FieldLabel>Prompt</FieldLabel>
          <textarea
            style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Trade BTC momentum breakouts with risk-managed position sizing"
            required
          />
        </div>

        <Button variant="primary" type="submit" disabled={mutation.isPending || !name || !prompt}>
          {mutation.isPending ? 'Creating...' : 'Create Agent'}
        </Button>
      </form>
    </Modal>
  );
}

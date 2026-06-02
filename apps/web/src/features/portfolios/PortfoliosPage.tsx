import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { portfolios as portfoliosApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button } from '../../lib/ui.js';

export function PortfoliosPage() {
  const [showCreate, setShowCreate] = useState(false);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['portfolios'],
    queryFn: () => portfoliosApi.list(),
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => portfoliosApi.create(name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['portfolios'] });
      setShowCreate(false);
    },
  });

  const items = query.data?.portfolios ?? [];

  return (
    <PageShell>
      <PageHeader
        title="Portfolios"
        subtitle="Group your trading positions"
        action={
          <Button variant="primary" onClick={() => setShowCreate(true)}>
            New portfolio
          </Button>
        }
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No portfolios yet"
          message="Create a portfolio to start grouping your trading positions."
          action={<Button variant="primary" onClick={() => setShowCreate(true)}>Create portfolio</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {items.map((p) => (
            <Card key={p.id} style={{ padding: '14px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontWeight: '500' }}>{p.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                    Created {new Date(p.createdAt).toLocaleDateString()}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showCreate && (
        <CreatePortfolioModal
          onClose={() => setShowCreate(false)}
          onCreate={(name) => createMutation.mutate(name)}
          isLoading={createMutation.isPending}
          error={createMutation.error as Error | null}
        />
      )}
    </PageShell>
  );
}

function CreatePortfolioModal({
  onClose,
  onCreate,
  isLoading,
  error,
}: {
  onClose: () => void;
  onCreate: (name: string) => void;
  isLoading: boolean;
  error: Error | null;
}) {
  const [name, setName] = useState('');

  return (
    <Modal title="Create portfolio" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onCreate(name.trim());
        }}
      >
        <div style={{ marginBottom: '20px' }}>
          <FieldLabel>Portfolio name</FieldLabel>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. BTC growth"
            style={inputStyle}
          />
        </div>
        {error && <ErrorBanner message={error.message} />}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
          <Button variant="primary" type="submit" disabled={isLoading || !name.trim()}>
            {isLoading ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// Shared modal / form primitives used by management pages
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        padding: '24px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-surface-1)',
          border: '1px solid var(--color-border)',
          borderRadius: '12px',
          padding: '28px',
          width: '100%',
          maxWidth: '480px',
        }}
      >
        <div style={{ fontWeight: '600', fontSize: '17px', marginBottom: '24px' }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: '7px',
  color: 'var(--color-text-primary)',
  fontSize: '14px',
  outline: 'none',
  boxSizing: 'border-box',
};

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '12px', fontWeight: '500', color: 'var(--color-text-secondary)', marginBottom: '6px' }}>
      {children}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: '10px 14px',
        background: 'var(--color-danger-subtle)',
        border: '1px solid var(--color-danger)',
        borderRadius: '7px',
        color: 'var(--color-danger)',
        fontSize: '13px',
        marginBottom: '16px',
      }}
    >
      {message}
    </div>
  );
}

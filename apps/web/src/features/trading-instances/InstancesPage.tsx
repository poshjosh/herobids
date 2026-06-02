import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  instances as instancesApi,
  portfolios as portfoliosApi,
  venueAccounts as venueAccountsApi,
} from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button, StatusBadge, RelativeTime, KV } from '../../lib/ui.js';
import { Modal, FieldLabel, ErrorBanner, inputStyle } from '../portfolios/PortfoliosPage.js';

const SUPPORTED_STRATEGIES = ['momentum'];

export function InstancesPage() {
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['instances'],
    queryFn: () => instancesApi.list(),
  });

  const startMutation = useMutation({
    mutationFn: (id: string) => instancesApi.start(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['instances'] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'overview'] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => instancesApi.stop(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['instances'] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'overview'] });
    },
  });

  const items = query.data?.instances ?? [];

  return (
    <PageShell>
      <PageHeader
        title="Agents"
        subtitle="Create and manage your trading agents"
        action={<Button variant="primary" onClick={() => setShowCreate(true)}>New agent</Button>}
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No agents yet"
          message="Create your first trading agent. Each agent runs one strategy against one venue account."
          action={<Button variant="primary" onClick={() => setShowCreate(true)}>Create agent</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {items.map((inst) => (
            <Card key={inst.id}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
                <div
                  style={{ flex: 1, cursor: 'pointer' }}
                  onClick={() => navigate(`/instances/${inst.id}`)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                    <span style={{ fontWeight: '600', fontSize: '15px' }}>{inst.strategyId}</span>
                    <StatusBadge status={inst.status} />
                  </div>
                  <div style={{ display: 'flex', gap: '24px' }}>
                    <KV label="Created" value={<RelativeTime timestamp={inst.createdAt} />} />
                    {inst.startedAt && <KV label="Started" value={<RelativeTime timestamp={inst.startedAt} />} />}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                  {inst.status === 'stopped' || inst.status === 'crashed' ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => startMutation.mutate(inst.id)}
                      disabled={startMutation.isPending}
                    >
                      Start
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => stopMutation.mutate(inst.id)}
                      disabled={stopMutation.isPending}
                    >
                      Stop
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateInstanceModal
          onClose={() => setShowCreate(false)}
          onSuccess={(id) => {
            void qc.invalidateQueries({ queryKey: ['instances'] });
            void qc.invalidateQueries({ queryKey: ['dashboard', 'overview'] });
            setShowCreate(false);
            navigate(`/instances/${id}`);
          }}
        />
      )}
    </PageShell>
  );
}

function CreateInstanceModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: (id: string) => void }) {
  const [portfolioId, setPortfolioId] = useState('');
  const [venueAccountId, setVenueAccountId] = useState('');
  const [strategyId, setStrategyId] = useState(SUPPORTED_STRATEGIES[0]!);
  const [symbol, setSymbol] = useState('');
  const [executionMode, setExecutionMode] = useState<'paper' | 'shadow' | 'live'>('paper');

  const portfoliosQuery = useQuery({ queryKey: ['portfolios'], queryFn: () => portfoliosApi.list() });
  const venueAccountsQuery = useQuery({ queryKey: ['venue-accounts'], queryFn: () => venueAccountsApi.list() });

  const portfolios = portfoliosQuery.data?.portfolios ?? [];
  const venueAccounts = venueAccountsQuery.data?.venueAccounts ?? [];

  const selectedVA = venueAccounts.find((va) => va.id === venueAccountId);

  const mutation = useMutation({
    mutationFn: () =>
      instancesApi.create({
        portfolioId,
        venueAccountId,
        strategyId,
        venue: selectedVA?.venue ?? '',
        symbol,
        config: {
          strategy: { type: strategyId, params: {} },
          venue: selectedVA?.venue ?? '',
          symbol,
          execution: { mode: executionMode },
        },
      }),
    onSuccess: (inst) => onSuccess(inst.id),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  const isReady = portfolioId && venueAccountId && symbol.trim();

  return (
    <Modal title="Create agent" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Portfolio</FieldLabel>
          <select value={portfolioId} onChange={(e) => setPortfolioId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            <option value="">— Select portfolio —</option>
            {portfolios.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {portfolios.length === 0 && <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '4px' }}>Create a portfolio first.</div>}
        </div>

        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Venue account</FieldLabel>
          <select value={venueAccountId} onChange={(e) => setVenueAccountId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            <option value="">— Select venue account —</option>
            {venueAccounts.map((va) => <option key={va.id} value={va.id}>{va.label} ({va.venue})</option>)}
          </select>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Strategy</FieldLabel>
          <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            {SUPPORTED_STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Symbol</FieldLabel>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="e.g. BTC-USDC" style={inputStyle} />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <FieldLabel>Execution mode</FieldLabel>
          <select value={executionMode} onChange={(e) => setExecutionMode(e.target.value as typeof executionMode)} style={{ ...inputStyle, cursor: 'pointer' }}>
            <option value="paper">Paper (simulated — no real orders)</option>
            <option value="shadow">Shadow (real signals, no orders)</option>
            <option value="live">Live (real orders)</option>
          </select>
        </div>

        {mutation.isError && <ErrorBanner message={(mutation.error as Error).message} />}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
          <Button variant="primary" type="submit" disabled={mutation.isPending || !isReady}>
            {mutation.isPending ? 'Creating…' : 'Create agent'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  bots as botsApi,
  venueAccounts as venueAccountsApi,
} from '../../lib/api-client.js';
import type { VenueAccount } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button, StatusBadge, RelativeTime, KV, Modal, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';

// ---------------------------------------------------------------------------
// Strategy presets — plain-language labels per plan 003
// ---------------------------------------------------------------------------
const STRATEGY_PRESETS = [
  { value: 'momentum', label: 'Follow the trend', description: 'Buys when markets are moving up, sells when they turn' },
  { value: 'dca', label: 'Steady accumulation', description: 'Buys a fixed amount at regular intervals regardless of price' },
  { value: 'range', label: 'Trade the range', description: 'Buys low and sells high within a price band' },
] as const;

type StrategyPresetValue = typeof STRATEGY_PRESETS[number]['value'];

export function InstancesPage() {
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['bots'],
    queryFn: () => botsApi.list(),
  });

  const startMutation = useMutation({
    mutationFn: (id: string) => botsApi.start(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bots'] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'overview'] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => botsApi.stop(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bots'] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'overview'] });
    },
  });

  const items = query.data?.bots ?? [];

  return (
    <PageShell>
      <PageHeader
        title="Bots"
        subtitle="Automated trading bots running strategies on your accounts"
        action={<Button variant="primary" onClick={() => setShowCreate(true)}>New Bot</Button>}
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No bots yet"
          message="Create a bot to start automated trading on a venue account."
          action={<Button variant="primary" onClick={() => setShowCreate(true)}>Create Bot</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {items.map((bot) => {
            const cfg = bot.config as Record<string, unknown> | null;
            const strategyType = (cfg?.['strategy'] as Record<string, unknown> | undefined)?.['type'] as string | undefined;
            const preset = STRATEGY_PRESETS.find((p) => p.value === strategyType);
            return (
              <Card key={bot.id}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
                  <div
                    style={{ flex: 1, cursor: 'pointer' }}
                    onClick={() => navigate(`/instances/${bot.id}`)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                      <span style={{ fontWeight: '600', fontSize: '15px' }}>{preset?.label ?? strategyType ?? 'Bot'}</span>
                      <StatusBadge status={bot.status} />
                    </div>
                    <div style={{ display: 'flex', gap: '24px' }}>
                      <KV label="Created" value={<RelativeTime timestamp={bot.createdAt} />} />
                      {bot.startedAt && <KV label="Started" value={<RelativeTime timestamp={bot.startedAt} />} />}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                    {bot.status === 'stopped' || bot.status === 'crashed' ? (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => startMutation.mutate(bot.id)}
                        disabled={startMutation.isPending}
                      >
                        Start
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => stopMutation.mutate(bot.id)}
                        disabled={stopMutation.isPending}
                      >
                        Stop
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {showCreate && (
        <CreateBotModal
          onClose={() => setShowCreate(false)}
          onSuccess={(id) => {
            void qc.invalidateQueries({ queryKey: ['bots'] });
            void qc.invalidateQueries({ queryKey: ['dashboard', 'overview'] });
            setShowCreate(false);
            navigate(`/instances/${id}`);
          }}
        />
      )}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Create Bot modal — primary: strategy preset + venue account + execution mode
//                   Advanced (collapsible): manual symbol entry
// ---------------------------------------------------------------------------
function CreateBotModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: (id: string) => void }) {
  const [venueAccountId, setVenueAccountId] = useState('');
  const [strategyPreset, setStrategyPreset] = useState<StrategyPresetValue>('momentum');
  const [executionMode, setExecutionMode] = useState<'paper' | 'shadow' | 'live'>('paper');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [manualSymbol, setManualSymbol] = useState('');
  const [selectedSymbol, setSelectedSymbol] = useState('');

  const venueAccountsQuery = useQuery({ queryKey: ['venue-accounts'], queryFn: () => venueAccountsApi.list() });
  const venueAccounts: VenueAccount[] = venueAccountsQuery.data?.venueAccounts ?? [];

  const selectedVA = venueAccounts.find((va) => va.id === venueAccountId);
  const availableSymbols = selectedVA?.venueProfile?.availableSymbols ?? [];
  const supportedModes = selectedVA?.venueProfile?.supportedExecutionModes ?? ['paper'];
  const venueType = selectedVA?.venueProfile?.venueType ?? 'orderbook';
  // Swap venues (e.g. Jupiter) require additional config (swapAssets, token decimals)
  // that isn't yet available in this UI form. Block create and guide to API/agent flow.
  const isSwapVenue = venueType === 'swap';

  const symbol = showAdvanced && manualSymbol.trim() ? manualSymbol.trim() : selectedSymbol;

  const mutation = useMutation({
    mutationFn: () => {
      const symbolToUse = symbol || (availableSymbols[0] ?? '');
      return botsApi.create({
        venueAccountId,
        venue: selectedVA?.venue ?? '',
        symbol: symbolToUse,
        config: {
          strategy: { type: strategyPreset, params: {} },
          venue: selectedVA?.venue ?? '',
          symbol: symbolToUse,
          venueType,
          execution: { mode: executionMode },
        },
      });
    },
    onSuccess: (bot) => onSuccess(bot.id),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  const isReady = !isSwapVenue && venueAccountId && (symbol || availableSymbols.length > 0);

  return (
    <Modal title="Create Bot" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {/* Strategy preset */}
        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Strategy</FieldLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {STRATEGY_PRESETS.map((p) => (
              <label
                key={p.value}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  padding: '10px 12px',
                  border: `1px solid ${strategyPreset === p.value ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  borderRadius: '6px',
                  cursor: 'pointer',
                  background: strategyPreset === p.value ? 'var(--color-accent-subtle, rgba(99,102,241,0.08))' : 'transparent',
                }}
              >
                <input
                  type="radio"
                  name="strategyPreset"
                  value={p.value}
                  checked={strategyPreset === p.value}
                  onChange={() => setStrategyPreset(p.value)}
                  style={{ marginTop: '2px', flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontWeight: '500', fontSize: '14px' }}>{p.label}</div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' }}>{p.description}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Venue account */}
        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Venue account</FieldLabel>
          <select
            value={venueAccountId}
            onChange={(e) => {
              setVenueAccountId(e.target.value);
              setSelectedSymbol('');
            }}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            <option value="">— Select venue account —</option>
            {venueAccounts.map((va) => (
              <option key={va.id} value={va.id}>{va.label} ({va.venue})</option>
            ))}
          </select>
        </div>

        {/* Instrument derived from venue profile */}
        {!showAdvanced && venueAccountId && (
          <div style={{ marginBottom: '16px' }}>
            <FieldLabel>Instrument</FieldLabel>
            {availableSymbols.length > 0 ? (
              <select
                value={selectedSymbol}
                onChange={(e) => setSelectedSymbol(e.target.value)}
                style={{ ...inputStyle, cursor: 'pointer' }}
              >
                <option value="">— Select instrument —</option>
                {availableSymbols.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : (
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', padding: '8px 0' }}>
                Instrument list unavailable. Enable Advanced to enter manually.
              </div>
            )}
          </div>
        )}

        {/* Execution mode */}
        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Execution mode</FieldLabel>
          <select
            value={executionMode}
            onChange={(e) => setExecutionMode(e.target.value as typeof executionMode)}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {supportedModes.includes('paper') && <option value="paper">Paper (simulated — no real orders)</option>}
            {supportedModes.includes('shadow') && <option value="shadow">Shadow (real signals, no orders)</option>}
            {supportedModes.includes('live') && <option value="live">Live (real orders)</option>}
          </select>
        </div>

        {/* Advanced toggle */}
        <div style={{ marginBottom: '16px' }}>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: '12px', padding: 0 }}
          >
            {showAdvanced ? '▾ Hide advanced' : '▸ Advanced'}
          </button>
        </div>

        {showAdvanced && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'var(--color-bg-subtle, rgba(0,0,0,0.04))', borderRadius: '6px' }}>
            <FieldLabel>Symbol (manual override)</FieldLabel>
            <input
              value={manualSymbol}
              onChange={(e) => setManualSymbol(e.target.value)}
              placeholder="e.g. BTC-PERP"
              style={inputStyle}
            />
          </div>
        )}

        {mutation.isError && <ErrorBanner message={(mutation.error as Error).message} />}

        {isSwapVenue && (
          <div style={{ padding: '10px 12px', background: 'var(--color-warning-subtle, rgba(245,158,11,0.1))', border: '1px solid var(--color-warning, #f59e0b)', borderRadius: '6px', fontSize: '13px', marginBottom: '16px' }}>
            <strong>Swap venue</strong> — {selectedVA?.venue} bots require additional token configuration (swap assets and decimals) that isn't yet available in this form. Use an AI agent with the Trading preset, or create bots via the API.
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
          <Button variant="primary" type="submit" disabled={mutation.isPending || !isReady}>
            {mutation.isPending ? 'Creating…' : 'Create Bot'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}




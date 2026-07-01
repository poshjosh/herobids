import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bots as botsApi, capabilities as capabilitiesApi } from '../../lib/api-client.js';
import type { Bot, ConnectionSummary, PresetFromApi } from '../../lib/api-client.js';
import {
  PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState,
  Button, StatusBadge, RelativeTime, KV, Modal, FieldLabel, ErrorBanner, inputStyle,
} from '../../lib/ui.js';

const STYLE_OPTIONS = [
  { value: 'economy', label: 'Economy', description: 'Fewer indicators, lower confidence thresholds' },
  { value: 'standard', label: 'Standard', description: 'Balanced indicators and risk' },
  { value: 'premium', label: 'Premium', description: 'Full indicator suite, strict confirmation' },
] as const;

const EXECUTION_MODES = [
  { value: 'paper', label: 'Paper', description: 'Simulated trading — no real money' },
  { value: 'shadow', label: 'Shadow', description: 'Tracks real prices but does not place orders' },
  { value: 'live', label: 'Live', description: 'Real order placement' },
] as const;

type ExecutionModeValue = typeof EXECUTION_MODES[number]['value'];

// ---------------------------------------------------------------------------
// BotsPage
// ---------------------------------------------------------------------------
export function BotsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['bots'],
    queryFn: () => botsApi.list(),
  });

  const items: Bot[] = query.data?.bots ?? [];

  return (
    <PageShell>
      <PageHeader
        title="Bots"
        subtitle="Trading bots created by you or your AI agents"
        action={<Button variant="primary" onClick={() => setShowCreate(true)}>Create Bot</Button>}
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && (
        <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />
      )}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No bots yet"
          message="Create one or let an AI agent create bots on your behalf."
          action={<Button variant="primary" onClick={() => setShowCreate(true)}>Create Bot</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {items.map((bot) => (
            <Card key={bot.id}>
              <div
                style={{ cursor: 'pointer' }}
                onClick={() => navigate(`/bots/${bot.id}`)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontWeight: '600', fontSize: '15px', fontFamily: 'monospace' }}>
                      {bot.id.slice(0, 8)}
                    </span>
                    <StatusBadge status={bot.status} />
                  </div>
                  <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                    {bot.creatorType === 'agent' ? `AI agent: ${bot.creatorId.slice(0, 8)}` : 'you'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                  <KV
                    label="Strategy"
                    value={String((bot.config['strategy'] as Record<string, unknown> | undefined)?.['type'] ?? '—')}
                  />
                  <KV
                    label="Mode"
                    value={String((bot.config['execution'] as Record<string, unknown> | undefined)?.['mode'] ?? 'paper')}
                  />
                  <KV label="Created" value={<RelativeTime timestamp={bot.createdAt} />} />
                  {bot.startedAt && <KV label="Started" value={<RelativeTime timestamp={bot.startedAt} />} />}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateBotModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void qc.invalidateQueries({ queryKey: ['bots'] });
          }}
        />
      )}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// CreateBotModal
// ---------------------------------------------------------------------------
interface CreateBotForm {
  connectionId: string;
  strategyPreset: string;
  executionMode: ExecutionModeValue;
  symbol: string;
}

function CreateBotModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<CreateBotForm>({
    connectionId: '',
    strategyPreset: 'momentum',
    executionMode: 'paper',
    symbol: '',
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [configJson, setConfigJson] = useState('');
  const [selectedStyle, setSelectedStyle] = useState<string>('standard');

  const tradingConnectionsQuery = useQuery({
    queryKey: ['capabilities', 'trading', 'connections'],
    queryFn: () => capabilitiesApi.tradingConnections(),
  });
  const tradingConnections: ConnectionSummary[] = (tradingConnectionsQuery.data?.connections ?? []).filter(
    (c) => c.status === 'active',
  );
  const selectedConnection = tradingConnections.find((c) => c.connectionId === form.connectionId) ?? null;

  const presetsQuery = useQuery({
    queryKey: ['blueprintPresets', selectedStyle],
    queryFn: () => botsApi.getPresets(selectedStyle),
  });
  const fetchedPresets: PresetFromApi[] = presetsQuery.data?.presets ?? [];

  const mutation = useMutation({
    mutationFn: () => {
      const preset = fetchedPresets.find((p) => p.key === form.strategyPreset);
      if (!preset) {
        throw new Error('Selected strategy preset not found');
      }
      const venue = selectedConnection?.provider;
      if (!venue) {
        throw new Error('Select a platform link before creating a bot');
      }
      let config: Record<string, unknown> = {
        strategy: preset.strategy,
        ...(preset.risk ? { risk: preset.risk } : {}),
        execution: { mode: form.executionMode },
        venue,
        symbol: form.symbol,
      };
      if (showAdvanced && configJson.trim()) {
        try {
          config = JSON.parse(configJson) as Record<string, unknown>;
        } catch {
          throw new Error('Invalid JSON in advanced config');
        }
      }
      if (!form.connectionId) {
        throw new Error('Select a platform link before creating a bot');
      }
      return botsApi.create({
        connectionId: form.connectionId,
        venue: (config['venue'] as string) || venue,
        symbol: form.symbol,
        config,
      });
    },
    onSuccess: onCreated,
  });

  const selectedPreset = fetchedPresets.find((p) => p.key === form.strategyPreset);

  return (
    <Modal title="Create Bot" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {/* Platform link */}
        <div>
          <FieldLabel>Platform link</FieldLabel>
          <select
            value={form.connectionId}
            onChange={(e) => setForm((s) => ({ ...s, connectionId: e.target.value }))}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            <option value="">— Select platform link —</option>
            {tradingConnections.map((c) => (
              <option key={c.connectionId} value={c.connectionId}>{c.label} ({c.provider})</option>
            ))}
          </select>
        </div>

        {/* Symbol */}
        <div>
          <FieldLabel>Symbol (e.g. BTC-PERP)</FieldLabel>
          <input
            type="text"
            style={inputStyle}
            value={form.symbol}
            onChange={(e) => setForm((s) => ({ ...s, symbol: e.target.value }))}
            placeholder="BTC-PERP"
          />
        </div>

        {/* Style tier */}
        <div>
          <FieldLabel>Strategy style</FieldLabel>
          <select
            value={selectedStyle}
            onChange={(e) => {
              setSelectedStyle(e.target.value);
              setForm((s) => ({ ...s, strategyPreset: '' }));
            }}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {STYLE_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label} — {s.description}</option>
            ))}
          </select>
        </div>

        {/* Strategy preset */}
        <div>
          <FieldLabel>Strategy</FieldLabel>
          {presetsQuery.isLoading && <LoadingRows count={3} />}
          {presetsQuery.isError && (
            <ErrorState message={(presetsQuery.error as Error).message} onRetry={() => void presetsQuery.refetch()} />
          )}
          {presetsQuery.isSuccess && fetchedPresets.length === 0 && (
            <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>No presets available for this style.</div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {fetchedPresets.map((p) => (
              <label
                key={p.key}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  padding: '10px 12px',
                  border: `1px solid ${form.strategyPreset === p.key ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  borderRadius: '6px',
                  cursor: 'pointer',
                  background: form.strategyPreset === p.key ? 'var(--color-accent-subtle, rgba(99,102,241,0.08))' : 'transparent',
                }}
              >
                <input
                  type="radio"
                  name="strategyPreset"
                  value={p.key}
                  checked={form.strategyPreset === p.key}
                  onChange={() => setForm((s) => ({ ...s, strategyPreset: p.key }))}
                  style={{ marginTop: '2px', flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontWeight: '500', fontSize: '14px' }}>{p.name}</div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                    {p.description}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Execution mode */}
        <div>
          <FieldLabel>Execution mode</FieldLabel>
          <select
            value={form.executionMode}
            onChange={(e) => setForm((s) => ({ ...s, executionMode: e.target.value as ExecutionModeValue }))}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {EXECUTION_MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label} — {m.description}</option>
            ))}
          </select>
        </div>

        {/* Advanced config toggle */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: '13px', padding: 0 }}
          >
            {showAdvanced ? '▼' : '▶'} Advanced: raw JSON config
          </button>
          {showAdvanced && (
            <textarea
              style={{ ...inputStyle, marginTop: '8px', minHeight: '120px', fontFamily: 'monospace', fontSize: '12px', resize: 'vertical' }}
              value={configJson}
              onChange={(e) => setConfigJson(e.target.value)}
              placeholder={JSON.stringify({
                strategy: { type: selectedPreset?.key ?? 'momentum', params: {} },
                risk: {},
                execution: { mode: form.executionMode },
                venue: selectedConnection?.provider ?? 'hyperliquid',
                symbol: form.symbol || 'BTC-PERP',
              }, null, 2)}
            />
          )}
        </div>

        {mutation.isError && <ErrorBanner message={(mutation.error as Error).message} />}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
          <Button
            variant="primary"
            type="button"
            disabled={mutation.isPending || presetsQuery.isLoading || !form.connectionId || !form.strategyPreset}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Creating…' : 'Create Bot'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

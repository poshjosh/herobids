import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bots as botsApi, capabilities as capabilitiesApi } from '../../lib/api-client.js';
import type { Bot, ConnectionSummary } from '../../lib/api-client.js';
import {
  PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState,
  Button, StatusBadge, RelativeTime, KV, Modal, FieldLabel, ErrorBanner, inputStyle,
} from '../../lib/ui.js';

// ---------------------------------------------------------------------------
// Strategy presets — mechanical-format params with required stopLossPct/takeProfitPct
// ---------------------------------------------------------------------------
const STRATEGY_PRESETS = [
  {
    value: 'momentum',
    label: 'Momentum — Day',
    description: 'Day-trend following on 15m candles. Tight stop, quick profit targets.',
    config: {
      strategy: {
        type: 'momentum',
        decisionMode: 'mechanical',
        params: {
          candleInterval: '15m',
          candleLimit: 48,
          minCandleCount: 20,
          stopLossPct: 3,
          takeProfitPct: 8,
          signalBias: 'trend-following',
          positionSize: '1',
          positionSizeMode: 'fixed',
          indicators: {
            rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70 },
            macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
            volume: { enabled: true, strongRatio: 1.5 },
            supportResistance: { enabled: false },
            vwap: { enabled: false },
            priceAction: { enabled: true, minChange24hPct: 3, maxChange24hPct: 50 },
            choch: { enabled: false },
            confidence: {
              rsiWeight: 0.25, macdCrossoverWeight: 0.30, macdIncreasingWeight: 0.15,
              volumeWeight: 0.20, breakoutWeight: 0.10,
              vwapWeight: 0, priceActionWeight: 0.10,
              chochBullishWeight: 0.15, chochBearishPenalty: 0.10,
              minConfidence: 0.40, minReasons: 2,
            },
          },
        },
      },
    },
  },
  {
    value: 'momentum-position',
    label: 'Momentum — Position',
    description: 'Longer-term trend following on 4H candles. Wider stops, bigger targets.',
    config: {
      strategy: {
        type: 'momentum',
        decisionMode: 'mechanical',
        params: {
          candleInterval: '4H',
          candleLimit: 72,
          minCandleCount: 30,
          stopLossPct: 8,
          takeProfitPct: 25,
          signalBias: 'trend-following',
          positionSize: '1',
          positionSizeMode: 'fixed',
          indicators: {
            rsi: { enabled: true, period: 14, healthyMin: 45, healthyMax: 75 },
            macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
            volume: { enabled: true, strongRatio: 1.8 },
            supportResistance: { enabled: true, lookback: 24, breakoutThreshold: 0.01 },
            vwap: { enabled: false },
            priceAction: { enabled: true, minChange24hPct: 8, maxChange24hPct: 60 },
            choch: { enabled: false },
            confidence: {
              rsiWeight: 0.20, macdCrossoverWeight: 0.25, macdIncreasingWeight: 0.20,
              volumeWeight: 0.20, breakoutWeight: 0.15,
              vwapWeight: 0, priceActionWeight: 0.10,
              chochBullishWeight: 0.15, chochBearishPenalty: 0.10,
              minConfidence: 0.45, minReasons: 2,
            },
          },
        },
      },
    },
  },
  {
    value: 'swing',
    label: 'Swing',
    description: 'Medium-term swing trading. 4H candles, CHOCH confirmations, moderate risk.',
    config: {
      strategy: {
        type: 'swing',
        decisionMode: 'mechanical',
        params: {
          candleInterval: '4H',
          candleLimit: 48,
          minCandleCount: 20,
          stopLossPct: 5,
          takeProfitPct: 15,
          signalBias: 'trend-following',
          positionSize: '1',
          positionSizeMode: 'fixed',
          indicators: {
            rsi: { enabled: true, period: 14, healthyMin: 48, healthyMax: 68 },
            macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
            volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.8 },
            supportResistance: { enabled: true, lookback: 24, breakoutThreshold: 0.01 },
            vwap: { enabled: false },
            priceAction: { enabled: true, minChange24hPct: 5, maxChange24hPct: 50 },
            choch: { enabled: true, swingLookback: 3, minSwingPct: 0.015, rejectOnBearish: true },
            confidence: {
              rsiWeight: 0.20, macdCrossoverWeight: 0.25, macdIncreasingWeight: 0.15,
              breakoutWeight: 0.25, volumeWeight: 0.20,
              vwapWeight: 0, priceActionWeight: 0.10,
              chochBullishWeight: 0.20, chochBearishPenalty: 0.15,
              minConfidence: 0.40, minReasons: 2,
            },
          },
        },
      },
    },
  },
  {
    value: 'range',
    label: 'Range Trading',
    description: 'Mean-reverting within ranges. Uses support/resistance bounces, RSI extremes.',
    config: {
      strategy: {
        type: 'range',
        decisionMode: 'mechanical',
        params: {
          candleInterval: '1H',
          candleLimit: 48,
          minCandleCount: 20,
          stopLossPct: 4,
          takeProfitPct: 8,
          signalBias: 'mean-reverting',
          positionSize: '1',
          positionSizeMode: 'fixed',
          indicators: {
            rsi: { enabled: true, period: 14, overbought: 75, weakBelow: 25 },
            macd: { enabled: false },
            volume: { enabled: true, strongRatio: 1.3 },
            supportResistance: { enabled: true, lookback: 30, breakoutThreshold: 0.005 },
            vwap: { enabled: false },
            priceAction: { enabled: false },
            choch: { enabled: false },
            confidence: {
              rsiWeight: 0.40, macdCrossoverWeight: 0.00, macdIncreasingWeight: 0.00,
              volumeWeight: 0.20, breakoutWeight: 0.40,
              vwapWeight: 0, priceActionWeight: 0,
              chochBullishWeight: 0, chochBearishPenalty: 0,
              minConfidence: 0.35, minReasons: 2,
            },
          },
        },
      },
    },
  },
  {
    value: 'contrarian',
    label: 'Contrarian',
    description: 'Fades extreme momentum. Mean-reverting against overbought/oversold signals.',
    config: {
      strategy: {
        type: 'contrarian',
        decisionMode: 'mechanical',
        params: {
          candleInterval: '1H',
          candleLimit: 48,
          minCandleCount: 20,
          stopLossPct: 5,
          takeProfitPct: 12,
          signalBias: 'mean-reverting',
          positionSize: '1',
          positionSizeMode: 'fixed',
          indicators: {
            rsi: { enabled: true, period: 14, overbought: 70, weakBelow: 30 },
            macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
            volume: { enabled: true, strongRatio: 1.5 },
            supportResistance: { enabled: true, lookback: 24, breakoutThreshold: 0.008 },
            vwap: { enabled: false },
            priceAction: { enabled: true, minChange24hPct: 10, maxChange24hPct: 40 },
            choch: { enabled: true, swingLookback: 3, minSwingPct: 0.01, rejectOnBearish: false },
            confidence: {
              rsiWeight: 0.35, macdCrossoverWeight: 0.15, macdIncreasingWeight: 0.10,
              volumeWeight: 0.20, breakoutWeight: 0.20,
              vwapWeight: 0, priceActionWeight: 0.10,
              chochBullishWeight: 0.10, chochBearishPenalty: 0.05,
              minConfidence: 0.40, minReasons: 2,
            },
          },
        },
      },
    },
  },
  {
    value: 'scalper',
    label: 'Scalper',
    description: 'Quick entries on 5m candles. Tight stops, fast exits, volume confirmation.',
    config: {
      strategy: {
        type: 'scalper',
        decisionMode: 'mechanical',
        params: {
          candleInterval: '5m',
          candleLimit: 30,
          minCandleCount: 15,
          stopLossPct: 2,
          takeProfitPct: 5,
          signalBias: 'trend-following',
          positionSize: '1',
          positionSizeMode: 'fixed',
          indicators: {
            rsi: { enabled: true, period: 7, healthyMin: 45, healthyMax: 65 },
            macd: { enabled: true, fast: 6, slow: 13, signal: 5 },
            volume: { enabled: true, strongRatio: 1.8, recentBars: 3, avgBars: 10 },
            supportResistance: { enabled: false },
            vwap: { enabled: false },
            priceAction: { enabled: false },
            choch: { enabled: false },
            confidence: {
              rsiWeight: 0.30, macdCrossoverWeight: 0.35, macdIncreasingWeight: 0.15,
              volumeWeight: 0.25, breakoutWeight: 0.05,
              vwapWeight: 0, priceActionWeight: 0,
              chochBullishWeight: 0.10, chochBearishPenalty: 0.05,
              minConfidence: 0.35, minReasons: 2,
            },
          },
        },
      },
    },
  },
  {
    value: 'dca',
    label: 'DCA',
    description: 'Dollar-cost averaging — buys at fixed intervals. No signal analysis needed.',
    config: {
      strategy: {
        type: 'dca',
        params: { intervalMs: 86400000, amountPerBuy: '10' },
      },
    },
  },
] as const;

type StrategyPresetValue = typeof STRATEGY_PRESETS[number]['value'];

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
  strategyPreset: StrategyPresetValue;
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

  const tradingConnectionsQuery = useQuery({
    queryKey: ['capabilities', 'trading', 'connections'],
    queryFn: () => capabilitiesApi.tradingConnections(),
  });
  const tradingConnections: ConnectionSummary[] = (tradingConnectionsQuery.data?.connections ?? []).filter(
    (c) => c.status === 'active',
  );
  const selectedConnection = tradingConnections.find((c) => c.connectionId === form.connectionId) ?? null;

  const mutation = useMutation({
    mutationFn: () => {
      const preset = STRATEGY_PRESETS.find((p) => p.value === form.strategyPreset)!;
      const venue = selectedConnection?.provider ?? 'hyperliquid';
      let config: Record<string, unknown> = {
        ...preset.config,
        execution: { mode: form.executionMode },
        venue,
        symbol: form.symbol,
      };
      // If preset has no decisionMode (e.g. DCA), ensure it's not in the config
      const strategyCfg = config['strategy'] as Record<string, unknown> | undefined;
      if (strategyCfg && !strategyCfg['decisionMode']) {
        delete strategyCfg['decisionMode'];
      }
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

  const selectedPreset = STRATEGY_PRESETS.find((p) => p.value === form.strategyPreset)!;

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

        {/* Strategy preset */}
        <div>
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
                  border: `1px solid ${form.strategyPreset === p.value ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  borderRadius: '6px',
                  cursor: 'pointer',
                  background: form.strategyPreset === p.value ? 'var(--color-accent-subtle, rgba(99,102,241,0.08))' : 'transparent',
                }}
              >
                <input
                  type="radio"
                  name="strategyPreset"
                  value={p.value}
                  checked={form.strategyPreset === p.value}
                  onChange={() => setForm((s) => ({ ...s, strategyPreset: p.value }))}
                  style={{ marginTop: '2px', flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontWeight: '500', fontSize: '14px' }}>{p.label}</div>
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
                strategy: { type: selectedPreset.value, params: {} },
                risk: {},
                execution: { mode: form.executionMode },
                venue: selectedBinding?.provider ?? 'hyperliquid',
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
            disabled={mutation.isPending || !form.connectionId}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Creating…' : 'Create Bot'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

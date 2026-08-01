import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { CapabilityReadiness } from '../../lib/api-client.js';
import { EditAgentModal } from './EditAgentModal.js';

const TECHNICAL_CONFIG = {
  filters: {
    venue: 'hyperliquid',
    venueType: 'orderbook',
  },
  indicators: {
    rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70, overbought: 80, weakBelow: 30 },
    macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
    volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.5, recentBars: 4, avgBars: 20 },
    choch: { enabled: false, swingLookback: 5, minSwingPct: 0.01, confirmBars: 2, rejectOnBearish: false },
    supportResistance: { enabled: false, lookback: 50, breakoutThreshold: 0.005 },
    confidence: {
      rsiWeight: 0.15,
      macdCrossoverWeight: 0.2,
      macdIncreasingWeight: 0.1,
      volumeWeight: 0.15,
      breakoutWeight: 0.15,
      chochBullishWeight: 0.15,
      chochBearishPenalty: 0.1,
      priceActionWeight: 0.1,
      minConfidence: 0.45,
      minReasons: 2,
    },
  },
  candles: { interval: '15m', limit: 100 },
  signalBias: 'trend-following',
  scanIntervalMs: 60_000,
  scanBatchSize: 5,
} as const;

function renderModal(options: {
  capabilityReadiness?: CapabilityReadiness;
  capital?: string;
  dailyLossLimit?: string;
  maxDrawdownPct?: number | null;
  maxSlippageBps?: number | '';
  maxOpenPositions?: number | '';
  maxPositionSizePct?: string;
  stopLossPct?: string;
  stopLossCooldownMs?: number | null;
  prompt?: string;
  tickIntervalMs?: number | null;
  technical?: Record<string, unknown> | null;
  availableConnections?: Array<{ connectionId: string; label: string; provider: string; status: string; connectionStatus?: string; profile?: Record<string, unknown> | null }>;
  allConnections?: Array<{ id: string; label: string; provider: string; status: string; profile?: Record<string, unknown> | null }>;
} = {}): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  if (options.capabilityReadiness) {
    queryClient.setQueryData(['agents', 'agent-123', 'capability-readiness', 'trading'], options.capabilityReadiness);
  }
  queryClient.setQueryData(['agents', 'risk-defaults'], {
    maxOpenPositions: 10,
    maxPositionSizePct: 100,
    stopLossPct: 10,
    stopLossCooldownMs: 300000,
  });
  queryClient.setQueryData(['capabilities', 'trading', 'connections'], {
    connections: options.availableConnections ?? [],
  });
  queryClient.setQueryData(['connections'], {
    connections: options.allConnections ?? [],
  });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <EditAgentModal
          agentId="agent-123"
          onClose={() => undefined}
          initialData={{
            id: 'agent-123',
            userId: 'user-1',
            name: 'Momentum scout',
            prompt: options.prompt ?? 'Watch BTC and trade breakouts.',
            skillIds: [],
            status: 'stopped',
            pauseState: null,
            toolPolicy: null,
            modelPolicy: null,
            provider: null,
            lightModel: null,
            heavyModel: null,
            costPreset: 'custom',
            dailySpendBudgetUsd: 0.5,
            dailyLlmTokenBudget: 45000,
            telegramChatId: null,
            executionMode: 'paper',
            dailyTokenBudget: 45000,
            dailyLossLimit: options.dailyLossLimit ?? '250',
            maxDrawdownPct: options.maxDrawdownPct ?? null,
            maxSlippageBps: options.maxSlippageBps === '' ? null : (options.maxSlippageBps ?? 25),
            maxOpenPositions: options.maxOpenPositions === '' ? null : (options.maxOpenPositions ?? 5),
            maxBots: null,
            maxPositionSizePct: options.maxPositionSizePct ?? '100',
            stopLossPct: options.stopLossPct ?? '10',
            stopLossCooldownMs: options.stopLossCooldownMs === undefined ? 300000 : options.stopLossCooldownMs,
            tickIntervalMs: options.tickIntervalMs ?? null,
            technical: options.technical ?? null,
            strategyPreset: null,
            capital: options.capital ?? '1500',
            style: null,
            openPositionEscalationToJudgePolicy: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('EditAgentModal rendering', () => {
  it('renders the shared controls and derived summaries for existing values', () => {
    const html = renderModal({
      capabilityReadiness: {
        family: 'trading',
        state: 'ready',
        connectionReadiness: 'ready',
        agentEligibility: 'eligible',
        effectiveReady: true,
        connectionId: 'binding-1',
        reasons: [],
      },
    });
    expect(html).toContain(messages['agents.controls.costPreset']);
    expect(html).toContain(messages['agents.controls.dailySpendBudget']);
    // Capital controls are now inside the (collapsed) Trading Setup advanced tab.
    expect(html).toContain(messages['agents.advanced.tradingSetup']);
    expect(html).toContain('Expected cadence: every 4h');
    expect(html).toContain('Estimated daily LLM spend: ~$0.50');
    expect(html).not.toContain(messages['agents.controls.dailyLlmTokenBudget']);
  });

  it('exposes the trading setup tab when capability readiness is already cached', () => {
    const html = renderModal({
      capabilityReadiness: {
        family: 'trading',
        state: 'ready',
        connectionReadiness: 'ready',
        agentEligibility: 'eligible',
        effectiveReady: true,
        connectionId: 'binding-1',
        reasons: [],
      },
    });

    // Trading guardrails now live in the (non-default) "Trading Setup" advanced tab.
    // The static render only emits the active tab's panel, so we assert the tab is present.
    expect(html).toContain(messages['agents.advanced.tradingSetup']);
  });

  it('omits the trading setup tab until capability readiness is loaded when no trading values are set', () => {
    const html = renderModal({
      capital: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownMs: null,
    });

    // "Trading" tab label may also appear in the agent-type selector; verify via the
    // capital field label and help text instead, which are unique to the trading tab.
    expect(html).not.toContain(messages['agents.controls.capital']);
    expect(html).not.toContain(messages['agents.controls.capital.help']);
  });

  it('renders only the canonical objective when the stored prompt contains legacy operator context', () => {
    const html = renderModal({
      prompt: 'Watch BTC and trade breakouts.\n\nOperator context:\n- Selected skills: Trading.\n- Risk tolerance: moderate.',
    });

    expect(html).toContain('Watch BTC and trade breakouts.');
    expect(html).not.toContain('Operator context:');
    expect(html).not.toContain('Risk tolerance: moderate.');
  });

  it('shows a preservation notice for legacy non-minute cadences', () => {
    const html = renderModal({ tickIntervalMs: 30_000 });

    expect(html).toContain(messages['agents.controls.tickInterval.legacyNotice']);
    expect(html).toContain('value="1"');
    expect(html).toContain('Base cadence: every 30s');
  });

  it('initializes in technical-only mode for agents with technical config and no objective text', () => {
    const html = renderModal({
      prompt: '',
      technical: TECHNICAL_CONFIG,
    });

    // The Strategy tab is only visible for trading agents. A technical-only
    // agent with no trading skills does not get the Strategy tab.
    // The objective field is always visible (pulled out of AgentFormBody) —
    // it drives capability mode derivation, even when empty.
    expect(html).not.toContain(messages['agents.advanced.strategy']);
    expect(html).toContain(messages['agents.edit.objective']);
    expect(html).not.toContain(messages['agents.create.skills']);
  });

  it('hides execution mode controls in technical-only mode even if the stored agent previously had a trading mode', () => {
    const html = renderModal({
      prompt: '',
      technical: TECHNICAL_CONFIG,
    });

    expect(html).not.toContain(messages['agents.executionMode.label']);
    expect(html).not.toContain(messages['agents.edit.executionModeHelp'].replace('{mode}', ''));
  });

  it('shows the add-connection empty state for non-trading agents with no existing connections', () => {
    const html = renderModal({
      prompt: '',
      technical: TECHNICAL_CONFIG,
      availableConnections: [],
      allConnections: [],
    });

    expect(html).toContain(messages['agents.create.connections']);
    expect(html).toContain(messages['agents.create.noConnections']);
    expect(html).toContain(messages['agents.create.addConnection']);
  });
});

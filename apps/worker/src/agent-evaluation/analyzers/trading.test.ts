import { describe, it, expect, vi } from 'vitest';
import { analyzeTrading } from './trading.js';
import type { EvidenceManifest } from '../collectors/evidence-assembler.js';
import type { EvaluationArtifactStore, EvaluationThresholds } from '@herobids/domain';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockStore(artifacts: Record<string, string>): EvaluationArtifactStore {
  return {
    write: vi.fn(),
    read: vi.fn(async (_runId: string, name: string) => {
      const content = artifacts[name];
      if (content === undefined) return null;
      return new TextEncoder().encode(content);
    }),
    list: vi.fn(),
  };
}

function defaultThresholds(): EvaluationThresholds {
  return {
    toolFailureRatePct: 20,
    highDrawdownPct: 20,
    negativeExpectancyFlag: true,
    veryShortHoldSec: 30,
    rateLimitAnomalyCount: 5,
    veryShortSessionSec: 60,
  };
}

function defaultManifest(overrides?: Partial<EvidenceManifest>): EvidenceManifest {
  return {
    entries: [
      { artifactName: 'fills.json', collected: true, itemCount: 5 },
      { artifactName: 'journal.json', collected: true, itemCount: 20 },
      { artifactName: 'sessions.json', collected: true, itemCount: 1 },
      { artifactName: 'positions.json', collected: true, itemCount: 2 },
      { artifactName: 'agent-metadata.json', collected: true },
    ],
    scope: { type: 'session', sessionId: 'sess-1' },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('analyzeTrading', () => {
  it('returns not applicable for non-trading agent with no fills', async () => {
    const store = mockStore({
      'agent-metadata.json': JSON.stringify({ id: 'agent-1', name: 'Research Agent' }),
      'fills.json': '[]',
    });
    const manifest = defaultManifest({
      entries: [
        { artifactName: 'fills.json', collected: true, itemCount: 0 },
        { artifactName: 'agent-metadata.json', collected: true },
      ],
    });

    const result = await analyzeTrading(store, 'run-1', manifest, defaultThresholds());
    for (const section of result) {
      expect(section.applicable).toBe(false);
      expect(section.score).toBe(0);
    }
  });

  it('returns applicable for agent with executionMode configured', async () => {
    const store = mockStore({
      'agent-metadata.json': JSON.stringify({ id: 'agent-1', name: 'Trading Agent', executionMode: 'paper' }),
    });
    const manifest = defaultManifest({
      entries: [
        { artifactName: 'fills.json', collected: true, itemCount: 0 },
        { artifactName: 'agent-metadata.json', collected: true },
      ],
    });

    const result = await analyzeTrading(store, 'run-2', manifest, defaultThresholds());
    const perfSection = result.find((s) => s.section === 'trading_performance');
    expect(perfSection!.applicable).toBe(true);
  });

  it('returns applicable for agent with dailyLossLimit configured', async () => {
    const store = mockStore({
      'agent-metadata.json': JSON.stringify({ id: 'agent-1', name: 'Trading Agent', dailyLossLimit: 500 }),
    });
    const manifest = defaultManifest({
      entries: [
        { artifactName: 'fills.json', collected: true, itemCount: 0 },
        { artifactName: 'agent-metadata.json', collected: true },
      ],
    });

    const result = await analyzeTrading(store, 'run-3', manifest, defaultThresholds());
    const perfSection = result.find((s) => s.section === 'trading_performance');
    expect(perfSection!.applicable).toBe(true);
  });

  it('flags info for trading-capable agent with no fills', async () => {
    const store = mockStore({
      'agent-metadata.json': JSON.stringify({ id: 'agent-1', name: 'Trading Agent', executionMode: 'paper' }),
      'fills.json': '[]',
    });

    const result = await analyzeTrading(store, 'run-4', defaultManifest(), defaultThresholds());
    const perfSection = result.find((s) => s.section === 'trading_performance');
    const noActivity = perfSection!.findings.find((f) => f.code === 'trading.no_activity');
    expect(noActivity).toBeDefined();
    expect(noActivity!.severity).toBe('info');
  });

  it('flags medium for negative expectancy', async () => {
    const store = mockStore({
      'agent-metadata.json': JSON.stringify({ executionMode: 'paper' }),
      'fills.json': JSON.stringify([
        { id: 'f-1', side: 'buy', symbol: 'ETH', quantity: '10', price: '3000', fee: null, feeCurrency: null, realizedPnlDelta: null, filledAt: '2026-01-15T10:30:00Z' },
      ]),
      'positions.json': JSON.stringify([
        { id: 'p-1', symbol: 'ETH', side: 'long', size: '10', entryPrice: '3000', realizedPnl: '-500.00', openedAt: '2026-01-15T10:00:00Z', closedAt: '2026-01-15T10:30:00Z' },
      ]),
    });

    const result = await analyzeTrading(store, 'run-5', defaultManifest(), defaultThresholds());
    const perfSection = result.find((s) => s.section === 'trading_performance');
    const negExp = perfSection!.findings.find((f) => f.code === 'trading.negative_expectancy');
    expect(negExp).toBeDefined();
    expect(negExp!.severity).toBe('medium');
  });

  it('flags high for large drawdown above threshold', async () => {
    // Entry notional: 10 * 3000 = 30000. Loss: -10000. Loss%: 10000/30000 = 33.3% > 20%
    const store = mockStore({
      'agent-metadata.json': JSON.stringify({ executionMode: 'paper' }),
      'fills.json': JSON.stringify([
        { id: 'f-1', side: 'buy', symbol: 'ETH', quantity: '10', price: '3000', fee: null, feeCurrency: null, realizedPnlDelta: null, filledAt: '2026-01-15T10:00:00Z' },
      ]),
      'positions.json': JSON.stringify([
        { id: 'p-bad', symbol: 'ETH', side: 'long', size: '10', entryPrice: '3000', realizedPnl: '-10000.00', openedAt: '2026-01-15T10:00:00Z', closedAt: '2026-01-15T11:00:00Z' },
        { id: 'p-ok', symbol: 'BTC', side: 'long', size: '0.1', entryPrice: '50000', realizedPnl: '100.00', openedAt: '2026-01-15T10:00:00Z', closedAt: '2026-01-15T11:00:00Z' },
      ]),
    });

    const result = await analyzeTrading(store, 'run-6', defaultManifest(), defaultThresholds());
    const perfSection = result.find((s) => s.section === 'trading_performance');
    const highDrawdown = perfSection!.findings.find((f) => f.code === 'trading.high_drawdown');
    expect(highDrawdown).toBeDefined();
    expect(highDrawdown!.severity).toBe('high');
  });

  it('does not flag drawdown below threshold', async () => {
    // Entry notional: 10 * 3000 = 30000. Loss: -3000. Loss%: 3000/30000 = 10% < 20%
    const store = mockStore({
      'agent-metadata.json': JSON.stringify({ executionMode: 'paper' }),
      'fills.json': JSON.stringify([
        { id: 'f-1', side: 'buy', symbol: 'ETH', quantity: '10', price: '3000', fee: null, feeCurrency: null, realizedPnlDelta: null, filledAt: '2026-01-15T10:00:00Z' },
      ]),
      'positions.json': JSON.stringify([
        { id: 'p-small-loss', symbol: 'ETH', side: 'long', size: '10', entryPrice: '3000', realizedPnl: '-3000.00', openedAt: '2026-01-15T10:00:00Z', closedAt: '2026-01-15T11:00:00Z' },
      ]),
    });

    const result = await analyzeTrading(store, 'run-7', defaultManifest(), defaultThresholds());
    const perfSection = result.find((s) => s.section === 'trading_performance');
    const highDrawdown = perfSection!.findings.find((f) => f.code === 'trading.high_drawdown');
    expect(highDrawdown).toBeUndefined();
  });

  it('flags info for open positions at scope end', async () => {
    const store = mockStore({
      'agent-metadata.json': JSON.stringify({ executionMode: 'paper' }),
      'fills.json': JSON.stringify([
        { id: 'f-1', side: 'buy', symbol: 'ETH', quantity: '10', price: '3000', fee: null, feeCurrency: null, realizedPnlDelta: null, filledAt: '2026-01-15T10:00:00Z' },
      ]),
      'positions.json': JSON.stringify([
        { id: 'p-open', symbol: 'ETH', side: 'long', size: '10', entryPrice: '3000', realizedPnl: '0', openedAt: '2026-01-15T10:00:00Z', closedAt: null },
      ]),
    });

    const result = await analyzeTrading(store, 'run-8', defaultManifest(), defaultThresholds());
    const perfSection = result.find((s) => s.section === 'trading_performance');
    const openPos = perfSection!.findings.find((f) => f.code === 'trading.open_positions_at_end');
    expect(openPos).toBeDefined();
    expect(openPos!.severity).toBe('info');
  });

  it('flags medium for rate limit anomalies', async () => {
    const journalEntries = [];
    for (let i = 0; i < 8; i++) {
      journalEntries.push({ id: `rl-${i}`, type: 'rate_limit', payload: { venue: 'hyperliquid' }, createdAt: new Date().toISOString() });
    }
    // threshold is 5, 8 > 5

    const store = mockStore({
      'agent-metadata.json': JSON.stringify({ executionMode: 'paper' }),
      'fills.json': JSON.stringify([
        { id: 'f-1', side: 'buy', symbol: 'BTC', quantity: '0.1', price: '50000', fee: null, feeCurrency: null, realizedPnlDelta: null, filledAt: '2026-01-15T10:00:00Z' },
      ]),
      'positions.json': '[]',
      'journal.json': JSON.stringify(journalEntries),
    });

    const result = await analyzeTrading(store, 'run-9', defaultManifest(), defaultThresholds());
    const rlSection = result.find((s) => s.section === 'rate_limits');
    const anomaly = rlSection!.findings.find((f) => f.code === 'trading.rate_limit_anomaly');
    expect(anomaly).toBeDefined();
    expect(anomaly!.severity).toBe('medium');
  });

  it('flags low for very short hold times', async () => {
    // 3 fills within 30 seconds → avg hold = 10s < 30s threshold
    const fills = [
      { id: 'f-1', side: 'buy', symbol: 'BTC', quantity: '0.1', price: '50000', fee: '5.00', feeCurrency: 'USDC', realizedPnlDelta: null, filledAt: '2026-01-15T10:00:00Z' },
      { id: 'f-2', side: 'sell', symbol: 'BTC', quantity: '0.1', price: '50100', fee: '5.01', feeCurrency: 'USDC', realizedPnlDelta: '10.00', filledAt: '2026-01-15T10:00:10Z' },
      { id: 'f-3', side: 'buy', symbol: 'ETH', quantity: '1', price: '3000', fee: '3.00', feeCurrency: 'USDC', realizedPnlDelta: null, filledAt: '2026-01-15T10:00:20Z' },
    ];

    const store = mockStore({
      'agent-metadata.json': JSON.stringify({ executionMode: 'paper' }),
      'fills.json': JSON.stringify(fills),
      'positions.json': '[]',
      'journal.json': '[]',
    });

    const result = await analyzeTrading(store, 'run-10', defaultManifest(), defaultThresholds());
    const behaviorSection = result.find((s) => s.section === 'trading_behavior');
    const shortHolds = behaviorSection!.findings.find((f) => f.code === 'trading.very_short_holds');
    expect(shortHolds).toBeDefined();
    expect(shortHolds!.severity).toBe('low');
  });

  it('returns expected section structure for applicable agent', async () => {
    const store = mockStore({
      'agent-metadata.json': JSON.stringify({ executionMode: 'paper' }),
      'fills.json': '[]',
      'positions.json': '[]',
      'journal.json': '[]',
    });

    const result = await analyzeTrading(store, 'run-11', defaultManifest(), defaultThresholds());
    const sectionNames = result.map((s) => s.section);
    expect(sectionNames).toContain('trading_performance');
    expect(sectionNames).toContain('trading_behavior');
    expect(sectionNames).toContain('market_data');
    expect(sectionNames).toContain('rate_limits');
    expect(result).toHaveLength(4);
  });
});

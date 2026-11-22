import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { accountSummaryToPortfolioUpdate } from './runtime-composition.js';

// Golden payloads: shape copied from traderton's real get_account_summary output
// (traderton packages/worker/src/tools/account.ts + account-summary.ts, and
// account.test.ts scenarios). If traderton changes the payload, re-copy the fixture.
const golden = JSON.parse(
  readFileSync(new URL('./fixtures/traderton-get-account-summary.golden.json', import.meta.url), 'utf8'),
) as Record<'neverEdited' | 'capitalEdited' | 'nullFields', Record<string, unknown>>;

afterEach(() => {
  vi.useRealTimers();
});

describe('accountSummaryToPortfolioUpdate (traderton golden payloads)', () => {
  it('maps every field of a never-edited account summary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T10:00:30.000Z'));

    expect(accountSummaryToPortfolioUpdate(golden.neverEdited)).toEqual({
      initialCapitalUsd: 1000,
      equityUsd: 850,
      availableCapitalUsd: 550,
      marginUsedUsd: 300,
      returnPct: -15,
      unrealizedPnlUsd: 50,
      unrealizedComplete: true,
      realizedPnlUsd: -200,
      pnlSinceCapitalChangeUsd: -200,
      lifetimeRealizedPnlUsd: -200,
      capitalChangedAt: null,
      peakEquityUsd: 1000,
      drawdownPct: -15,
      fundingIncluded: false,
      asOf: '2026-11-21T10:00:00.000Z',
      freshness: { state: 'fresh', provider: 'account-summary-tool', ageMs: 30_000 },
    });
  });

  it('maps a capital-edited summary with period-scoped realized P&L and incomplete unrealized', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T12:30:00.000Z'));

    expect(accountSummaryToPortfolioUpdate(golden.capitalEdited)).toEqual({
      initialCapitalUsd: 2000,
      equityUsd: 2080.5,
      availableCapitalUsd: 30.5,
      marginUsedUsd: 2050,
      returnPct: 4.025,
      unrealizedPnlUsd: 50.5,
      unrealizedComplete: false,
      realizedPnlUsd: 30,
      pnlSinceCapitalChangeUsd: 30,
      lifetimeRealizedPnlUsd: -200,
      capitalChangedAt: '2026-11-21T09:00:00.000Z',
      peakEquityUsd: 2080.5,
      drawdownPct: 0,
      fundingIncluded: false,
      asOf: '2026-11-21T12:30:00.000Z',
      freshness: { state: 'fresh', provider: 'account-summary-tool', ageMs: 0 },
    });
  });

  it('maps null boundary fields to null without inventing values', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T10:00:00.000Z'));

    expect(accountSummaryToPortfolioUpdate(golden.nullFields)).toEqual({
      initialCapitalUsd: null,
      equityUsd: null,
      availableCapitalUsd: null,
      marginUsedUsd: null,
      returnPct: null,
      unrealizedPnlUsd: null,
      unrealizedComplete: null,
      realizedPnlUsd: null,
      pnlSinceCapitalChangeUsd: null,
      lifetimeRealizedPnlUsd: null,
      capitalChangedAt: null,
      peakEquityUsd: null,
      drawdownPct: null,
      fundingIncluded: false,
      asOf: '2026-11-21T10:00:00.000Z',
      freshness: { state: 'fresh', provider: 'account-summary-tool', ageMs: 0 },
    });
  });
});

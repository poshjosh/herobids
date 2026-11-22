import type { RuntimePortfolioSummary } from './runtime-composition.js';
import { fmtUsd } from './fmt.js';

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unavailable';
  // Compact format for large values saves tokens.
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${abs >= 10_000 ? fmtUsd(abs) : `$${abs.toFixed(2)}`}`;
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unavailable';
  return `${value.toFixed(2)}%`;
}

function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

/** "as of 2026-11-21T10:00:00.000Z, 3m ago" — or "as of unknown" when the boundary gave no time. */
export function formatAsOf(asOf: string | null, now: number): string {
  const ms = asOf === null ? Number.NaN : Date.parse(asOf);
  if (!Number.isFinite(ms)) return 'as of unknown';
  return `as of ${asOf}, ${formatAge(Math.max(0, now - ms))}`;
}

/**
 * Data-only account lines shared by the tick portfolio block and the hybrid
 * prompt. Labels follow Traderton's definitions: `initialCapital` is the
 * configured allocation, equity is a balance, and available capital is
 * equity minus margin used. Pure data: no limits or instructions.
 */
export function buildAccountLines(portfolio: RuntimePortfolioSummary, now: number): string[] {
  const noFunding = portfolio.fundingIncluded === false ? ', excluding funding' : '';
  const lines: string[] = [];

  lines.push(`Initial capital (configured allocation): ${usd(portfolio.initialCapitalUsd)}`);
  const partial = portfolio.unrealizedComplete === false ? '; partial, some open positions have no mark' : '';
  lines.push(`Equity (${formatAsOf(portfolio.asOf, now)}${noFunding}${partial}): ${usd(portfolio.equityUsd)}`);
  if (portfolio.marginUsedUsd !== null) lines.push(`Margin used: ${usd(portfolio.marginUsedUsd)}`);
  lines.push(`Available capital (equity minus margin used): ${usd(portfolio.availableCapitalUsd)}`);
  if (portfolio.returnPct !== null) lines.push(`Return since capital change: ${pct(portfolio.returnPct)}`);

  if (portfolio.lifetimeRealizedPnlUsd !== null) {
    lines.push(`Lifetime realized P&L (all time${noFunding}): ${usd(portfolio.lifetimeRealizedPnlUsd)}`);
  }
  if (portfolio.pnlSinceCapitalChangeUsd !== null) {
    const since = portfolio.capitalChangedAt ? `since ${portfolio.capitalChangedAt}` : 'since start; capital never changed';
    lines.push(`Realized P&L since capital change (${since}${noFunding}): ${usd(portfolio.pnlSinceCapitalChangeUsd)}`);
  } else if (portfolio.lifetimeRealizedPnlUsd === null) {
    lines.push(`Realized P&L: ${usd(portfolio.realizedPnlUsd)}`);
  }

  const unrealizedNote = portfolio.unrealizedComplete === false ? '; incomplete, some open positions have no mark' : '';
  lines.push(`Unrealized P&L (point-in-time, ${formatAsOf(portfolio.asOf, now)}${unrealizedNote}): ${usd(portfolio.unrealizedPnlUsd)}`);

  const peak = portfolio.peakEquityUsd !== null ? ` (peak equity ${usd(portfolio.peakEquityUsd)})` : '';
  lines.push(`Drawdown: ${pct(portfolio.drawdownPct)}${peak}`);
  return lines;
}

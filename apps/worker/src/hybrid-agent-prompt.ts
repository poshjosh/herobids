import type { HybridPricingIdentity, RuntimeFreshness, RuntimeVenueSignal, TechnicalScanState, RuntimePortfolioSummary, RuntimePositionSnapshot } from './runtime-composition.js';
import { fmtUsd } from './fmt.js';

export interface HybridPromptInput {
  scan: TechnicalScanState;
  portfolio: RuntimePortfolioSummary;
  openPositions: RuntimePositionSnapshot[];
  maxPositions: number;
  /** Agent memory snapshot for hybrid prompt enrichment. */
  agentMemory?: Record<string, { value: unknown; updatedAt?: string }> | null;
  /** Max inline memory keys rendered. */
  maxInlineMemoryKeys?: number;
  /** Recent judge responses (newest last). */
  recentJudgeResponses?: string[];
  /** Venue intelligence for signal and open-position instruments. */
  venueSignals?: RuntimeVenueSignal[];
}

// ─── Venue intelligence helpers ──────────────────────────────────────────

function formatStalenessSuffix(freshness: RuntimeFreshness): string {
  if (freshness.state === 'stale' && freshness.ageMs !== undefined) {
    return ` (stale ${Math.max(1, Math.round(freshness.ageMs / 60_000))}m)`;
  }
  return '';
}

function getVenueField(
  venueSignal: RuntimeVenueSignal | undefined,
  label: string,
): string {
  if (!venueSignal) return '—';
  const field = venueSignal.fields.find((f) => f.label === label);
  return field?.value ?? '—';
}

/**
 * Normalize a pricing-identity symbol to its base form for venue-signal matching.
 * Hyperliquid stores the base asset (e.g. "BTC"), Bybit stores the full market
 * ticker (e.g. "BTCUSDT"). Both must match a venue signal whose instrument is
 * the base symbol.
 */
function normalizePricingSymbol(symbol: string): string {
  return symbol.toUpperCase()
    .replace(/USDT$|USD$|PERP$/i, '')
    .replace(/[-/].*$/, '');
}

function parseDexVenueInstrument(instrument: string): { symbol: string; network?: string } {
  const upper = instrument.toUpperCase();
  const parenIdx = upper.indexOf(' (');
  if (parenIdx === -1 || !upper.endsWith(')')) {
    return { symbol: upper };
  }

  return {
    symbol: upper.slice(0, parenIdx),
    network: upper.slice(parenIdx + 2, -1),
  };
}

function resolveVenueSignalForInstrument(
  instrumentId: string,
  pricingIdentities: Record<string, HybridPricingIdentity> | undefined,
  venueSignals: RuntimeVenueSignal[],
): RuntimeVenueSignal | undefined {
  const pricingId = pricingIdentities?.[instrumentId];
  if (!pricingId) return undefined;

  const normalizedSymbol = normalizePricingSymbol(pricingId.symbol);

  return venueSignals.find((vs) => {
    const vsInstrument = vs.instrument.toUpperCase();

    // Exact match (Hyperliquid base-symbol case).
    if (vsInstrument === normalizedSymbol) return true;

    // DEX: venue signal instrument is formatted as "SYMBOL (network)".
    // When a network-qualified row is present, require chain alignment so
    // same-symbol assets on different networks do not inherit the wrong row.
    if (pricingId.kind === 'dex') {
      const parsed = parseDexVenueInstrument(vsInstrument);
      if (parsed.symbol !== normalizedSymbol) return false;
      if (!parsed.network) return true;
      if (!pricingId.chain) return false;
      return parsed.network === pricingId.chain.toUpperCase();
    }

    return false;
  });
}

/**
 * Build a single-shot prompt for hybrid agent evaluation.
 * The prompt presents pre-scored signals from the technical scanner and asks
 * the LLM to emit structured JSON decisions — no tool calling.
 */
export function buildHybridPrompt(input: HybridPromptInput): string {
  const { scan, portfolio, openPositions, maxPositions, agentMemory, maxInlineMemoryKeys, recentJudgeResponses, venueSignals } = input;

  const lines: string[] = [];

  // System instruction
  lines.push('You are a trading agent. Below are pre-scored signals from your technical scanner.');
  lines.push('');

  // Capital and position context
  const formattedCapital = fmtUsd(portfolio.availableCapitalUsd);
  const capitalStr = formattedCapital === 'unavailable' ? 'unknown' : formattedCapital;
  lines.push(`Available capital: ${capitalStr}`);
  lines.push(`Max positions: ${maxPositions}`);

  const activePositions = openPositions.filter((p) => p.side !== 'flat');
  if (activePositions.length > 0) {
    lines.push('');
    lines.push('## Open Positions');
    lines.push('| Instrument ID | Side | Entry | Size | Unrealized PnL |');
    lines.push('|---------------|------|-------|------|----------------|');
    for (const pos of activePositions) {
      const entryStr = pos.entryPrice ?? '—';
      const sizeStr = pos.size;
      const pnlStr = pos.unrealizedPnlUsd !== null ? fmtUsd(pos.unrealizedPnlUsd) : '—';
      lines.push(`| ${pos.instrumentId} | ${pos.side} | ${entryStr} | ${sizeStr} | ${pnlStr} |`);
    }
  } else {
    lines.push('Open positions: none');
  }

  // ── Recent Agent Decisions (Phase 3) ─────────────────────────────────────
  if (recentJudgeResponses && recentJudgeResponses.length > 0) {
    lines.push('');
    lines.push('## Recent Agent Decisions');
    const count = recentJudgeResponses.length;
    for (let i = 0; i < count; i++) {
      const label = `[Tick -${count - i}]`;
      const summary = recentJudgeResponses[i]!.length > 120
        ? recentJudgeResponses[i]!.slice(0, 120) + '…'
        : recentJudgeResponses[i]!;
      lines.push(`${label}: ${summary}`);
    }
  }

  // ── Agent Memory (Phase 2) ───────────────────────────────────────────────
  if (agentMemory && Object.keys(agentMemory).length > 0) {
    const entries = Object.entries(agentMemory);
    entries.sort(([, a], [, b]) => {
      const aTs = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bTs = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      if (Number.isFinite(aTs) && Number.isFinite(bTs)) return bTs - aTs;
      if (Number.isFinite(aTs)) return -1;
      if (Number.isFinite(bTs)) return 1;
      return 0;
    });

    const maxInline = maxInlineMemoryKeys ?? 12;
    const inline = entries.slice(0, maxInline);
    const overflow = entries.slice(maxInline);

    lines.push('');
    lines.push('## Agent Memory');
    for (const [key, entry] of inline) {
      const ts = entry.updatedAt ? ` (${new Date(entry.updatedAt).toISOString().substring(0, 19)})` : '';
      const val = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
      lines.push(`**${key}**${ts}: ${val}`);
    }
    if (overflow.length > 0) {
      const overflowKeys = overflow.map(([k]) => k).join(', ');
      lines.push(`Older keys: ${overflowKeys} (+${overflow.length} more — use list_memory_keys tool)`);
    }
  }

  // Signal table from technical scan
  const ageMs = Date.now() - Date.parse(scan.timestamp);
  if (ageMs <= 2 * scan.scanIntervalMs && (scan.signals.length > 0 || scan.regimeResult !== null)) {
    lines.push('');
    lines.push('## Technical Scan Results');
    const regimePart = scan.regimeResult !== null
      ? `Regime: ${scan.regimeResult.pass ? 'PASS' : 'BLOCK'} (ADX ${scan.regimeResult.details.adxValue.toFixed(0)}, ${scan.regimeResult.details.emaAlignment} alignment)`
      : 'Regime: not evaluated';
    lines.push(`Last scan: ${scan.timestamp} | ${regimePart}`);

    if (scan.signals.length > 0) {
      lines.push('');
      lines.push('### Top Signals (ranked by confidence)');
      lines.push('| Instrument ID | Symbol | Confidence | RSI | MACD | Volume | CHOCH | Reasons |');
      lines.push('|---------------|--------|------------|-----|------|--------|-------|---------|');
      for (const signal of scan.signals) {
        const rsiStr = signal.indicators.rsi !== undefined ? String(signal.indicators.rsi.toFixed(0)) : '—';
        const macdStr = signal.indicators.macdHistogram === undefined
          ? '—'
          : signal.indicators.macdHistogram > 0
            ? '+bullish crossover'
            : signal.indicators.macdHistogram < 0
              ? '—bearish'
              : '—';
        const volStr = signal.indicators.volumeRatio !== undefined
          ? `${signal.indicators.volumeRatio.toFixed(1)}x`
          : '—';
        const chochStr = signal.indicators.choch ? signal.indicators.choch : '—';
        lines.push(`| ${signal.instrumentId} | ${signal.symbol} | ${signal.confidence.toFixed(2)} | ${rsiStr} | ${macdStr} | ${volStr} | ${chochStr} | ${signal.reasons.join(', ')} |`);
      }
    }

    lines.push('');
    // ── Rejection landscape (Phase 3) ─────────────────────────────────
    const rejectionParts: string[] = [];
    if (scan.symbolOutcomes.length > 0) {
      let unsupported = 0;
      let emptyCandles = 0;
      let fetchFailures = 0;
      for (const outcome of scan.symbolOutcomes) {
        if (outcome.status === 'unsupported') unsupported++;
        else if (outcome.status === 'eligible_empty') emptyCandles++;
        else if (outcome.status === 'transient_failure') fetchFailures++;
      }
      if (unsupported > 0) rejectionParts.push(`${unsupported} unsupported`);
      if (emptyCandles > 0) rejectionParts.push(`${emptyCandles} no candle data`);
      if (fetchFailures > 0) rejectionParts.push(`${fetchFailures} fetch failure`);
    }
    const breakdownLine = rejectionParts.length > 0
      ? `\nRejection breakdown: ${rejectionParts.join(', ')}`
      : '';
    lines.push(`### Rejected\n${scan.summary.scanned} instruments scanned, ${scan.summary.rejected} rejected (${scan.summary.passed} passed filters)${breakdownLine}`);
  }

  // ── Venue Intelligence (Phase 1) ──────────────────────────────────────
  if (venueSignals && venueSignals.length > 0) {
    // Collect instrumentIds from signals and open positions.
    const relevantIds = new Set<string>();
    for (const signal of scan.signals) {
      relevantIds.add(signal.instrumentId);
    }
    for (const pos of openPositions) {
      relevantIds.add(pos.instrumentId);
    }

    // Resolve venue signals for each relevant instrument.
    const venueRows: Array<{
      instrumentId: string;
      venueSignal: RuntimeVenueSignal | undefined;
    }> = [];
    for (const instrumentId of relevantIds) {
      const vs = resolveVenueSignalForInstrument(instrumentId, scan.pricingIdentities, venueSignals);
      venueRows.push({ instrumentId, venueSignal: vs });
    }

    // Only render the section if at least one instrument matched a venue signal.
    const hasAnyMatch = venueRows.some((r) => r.venueSignal !== undefined);
    if (hasAnyMatch) {
      lines.push('');
      lines.push('## Venue Intelligence');
      lines.push('| Instrument ID | Funding Rate | 24h Change | 24h Volume | Open Interest |');
      lines.push('|---------------|-------------|------------|------------|---------------|');
      for (const row of venueRows) {
        const vs = row.venueSignal;
        const staleness = vs ? formatStalenessSuffix(vs.freshness) : '';
        const funding = vs ? `${getVenueField(vs, 'Funding')}${staleness}` : '—';
        const change = vs ? `${getVenueField(vs, '24h change')}${staleness}` : '—';
        const volume = vs ? `${getVenueField(vs, '24h volume')}${staleness}` : '—';
        const oi = vs ? `${getVenueField(vs, 'Open interest')}${staleness}` : '—';
        lines.push(`| ${row.instrumentId} | ${funding} | ${change} | ${volume} | ${oi} |`);
      }
    }
  }

  // Explicit exit review section for positions flagged by the scanner
  const exitFlagged = scan.positionIndicators.filter((ind) => ind.exitAdvisory === true);
  if (exitFlagged.length > 0) {
    lines.push('');
    lines.push('## Positions flagged for exit review');
    lines.push('| Instrument ID | Side | Entry | Current | P&L | Hold | RSI | Signal Note |');
    lines.push('|---------------|------|-------|---------|-----|------|-----|-------------|');
    for (const ind of exitFlagged) {
      const id = (ind.instrumentId ?? ind.symbol);
      const entryStr = ind.entryPrice !== undefined ? `$${ind.entryPrice.toFixed(4)}` : '—';

      // Cross-reference openPositions for P&L, hold duration, and current price.
      const matchingPos = openPositions.find(
        (p) => p.instrumentId === ind.symbol || p.instrumentId === (ind.instrumentId ?? ind.symbol),
      );

      let currentStr = '—';
      if (ind.currentPrice !== undefined) {
        currentStr = `$${ind.currentPrice.toFixed(4)}`;
      } else if (matchingPos?.entryPrice !== null && matchingPos?.entryPrice !== undefined
        && matchingPos.unrealizedPnlUsd !== null && matchingPos.unrealizedPnlUsd !== undefined) {
        const entry = Number(matchingPos.entryPrice);
        const size = Number(matchingPos.size);
        if (Number.isFinite(entry) && Number.isFinite(size) && size !== 0) {
          const current = entry + matchingPos.unrealizedPnlUsd / size;
          currentStr = `$${current.toFixed(4)}`;
        }
      }

      const pnlStr = matchingPos?.unrealizedPnlUsd !== null && matchingPos?.unrealizedPnlUsd !== undefined
        ? fmtUsd(matchingPos.unrealizedPnlUsd)
        : '—';

      const holdStr = matchingPos?.holdDurationMinutes !== null && matchingPos?.holdDurationMinutes !== undefined
        ? `${matchingPos.holdDurationMinutes}m`
        : '—';

      const rsiStr = ind.rsi !== undefined ? String(ind.rsi.toFixed(0)) : '—';
      const note = ind.signalNote ?? '—';
      lines.push(`| ${id} | ${ind.side} | ${entryStr} | ${currentStr} | ${pnlStr} | ${holdStr} | ${rsiStr} | ${note} |`);
    }
    lines.push('');
    lines.push('For each flagged position above, respond with `go_flat` to exit or `hold` to keep using the exact `instrumentId` shown in the table.');
  }

  // Instructions
  lines.push('');
  lines.push('## Instructions');
  lines.push('For each entry signal, respond with `go_long` and a USD size, or `skip`.');
  lines.push('Use the exact `instrumentId` from the tables in your JSON response.');
  lines.push('For each position flagged for exit review, respond with `go_flat` to exit or `hold` to keep.');
  lines.push('Do not re-analyze indicators — trust the scanner\'s scores.');
  lines.push('Size recommendations:');
  lines.push(`- Max ${maxPositions} positions total, ${activePositions.length} currently open`);
  if (portfolio.availableCapitalUsd !== null && portfolio.availableCapitalUsd !== undefined && portfolio.availableCapitalUsd > 0) {
    const perPositionCap = portfolio.availableCapitalUsd / Math.max(1, maxPositions);
    lines.push(`- Suggested max ${maxPositions} positions, ~${fmtUsd(perPositionCap)} each`);
  }
  lines.push('');
  lines.push('Respond ONLY with a JSON array:');
  lines.push('```json');
  lines.push('[{"instrumentId":"SOL-PERP","intent":"go_long","sizeUsd":50,"reason":"high confidence, strong volume"},{"instrumentId":"ETH-PERP","intent":"skip","reason":"low confidence (0.40)"},{"instrumentId":"BTC-PERP","intent":"go_flat","reason":"stop loss triggered"}]');
  lines.push('```');

  return lines.join('\n');
}

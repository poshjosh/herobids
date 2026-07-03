import type { TechnicalScanState, RuntimePortfolioSummary, RuntimePositionSnapshot } from './runtime-composition.js';
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
}

/**
 * Build a single-shot prompt for hybrid agent evaluation.
 * The prompt presents pre-scored signals from the technical scanner and asks
 * the LLM to emit structured JSON decisions — no tool calling.
 */
export function buildHybridPrompt(input: HybridPromptInput): string {
  const { scan, portfolio, openPositions, maxPositions, agentMemory, maxInlineMemoryKeys, recentJudgeResponses } = input;

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
    lines.push(`### Rejected\n${scan.summary.scanned} instruments scanned, ${scan.summary.rejected} rejected (${scan.summary.passed} passed filters)`);
  }

  // Explicit exit review section for positions flagged by the scanner
  const exitFlagged = scan.positionIndicators.filter((ind) => ind.exitAdvisory === true);
  if (exitFlagged.length > 0) {
    lines.push('');
    lines.push('## Positions flagged for exit review');
    lines.push('| Instrument ID | Side | Entry | RSI | Signal Note |');
    lines.push('|---------------|------|-------|-----|-------------|');
    for (const ind of exitFlagged) {
      const id = (ind.instrumentId ?? ind.symbol);
      const entryStr = ind.entryPrice !== undefined ? `$${ind.entryPrice.toFixed(4)}` : '—';
      const rsiStr = ind.rsi !== undefined ? String(ind.rsi.toFixed(0)) : '—';
      const note = ind.signalNote ?? '—';
      lines.push(`| ${id} | ${ind.side} | ${entryStr} | ${rsiStr} | ${note} |`);
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
  lines.push('[{"instrumentId":"SOL-PERP","intent":"go_long","sizeUsd":50},{"instrumentId":"ETH-PERP","intent":"skip"},{"instrumentId":"BTC-PERP","intent":"go_flat"}]');
  lines.push('```');

  return lines.join('\n');
}

import type { EvaluationArtifactStore, EvaluationSectionScore, EvaluationFinding } from '@herobids/domain';
import type { EvaluationThresholds } from '@herobids/domain';
import type { EvidenceManifest } from '../collectors/evidence-assembler.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function readJsonArtifact(store: EvaluationArtifactStore, runId: string, name: string): Promise<unknown> {
  const data = await store.read(runId, name);
  if (!data) return null;
  return JSON.parse(new TextDecoder().decode(data));
}

interface FillRow {
  side: string;
  symbol: string;
  quantity: string;
  price: string;
  fee: string | null;
  feeCurrency: string | null;
  realizedPnlDelta: string | null;
  filledAt: string;
}

interface PositionRow {
  id: string;
  symbol: string;
  side: string;
  size: string;
  entryPrice: string;
  realizedPnl: string;
  openedAt: string;
  closedAt: string | null;
}

interface JournalRow {
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

function finding(
  section: EvaluationSectionScore['section'],
  severity: EvaluationFinding['severity'],
  code: string,
  title: string,
  detail: string,
  evidence?: string,
): EvaluationFinding {
  return { section, severity, code, title, detail, evidence };
}

// ── Trading analyzer ────────────────────────────────────────────────────────

/**
 * Trading analyzer — runs only if the agent has trading capability or fills exist.
 * Returns `{ applicable: false }` for non-trading agents.
 *
 * Trading capability is detected from the agent-metadata artifact:
 * an agent is considered trading-capable if it has an execution mode,
 * a daily loss limit, or a max slippage setting configured.
 */
export async function analyzeTrading(
  store: EvaluationArtifactStore,
  runId: string,
  manifest: EvidenceManifest,
  thresholds: EvaluationThresholds,
): Promise<EvaluationSectionScore[]> {
  const fillsEntry = manifest.entries.find((e) => e.artifactName === 'fills.json');

  const hasFills = fillsEntry?.collected && (fillsEntry.itemCount ?? 0) > 0;

  // Determine trading capability from agent metadata (not fill presence)
  const agentMeta = await readJsonArtifact(store, runId, 'agent-metadata.json') as Record<string, unknown> | null;
  const hasTradingCapability = agentMeta != null && (
    agentMeta['executionMode'] != null ||
    agentMeta['executionModeCanonical'] != null ||
    agentMeta['dailyLossLimit'] != null ||
    agentMeta['dailyMaxLossPct'] != null ||
    agentMeta['maxSlippageBps'] != null ||
    agentMeta['slippageBps'] != null
  );

  // Applicable if the agent is trading-capable OR has fills in the scope
  const isApplicable = hasTradingCapability || hasFills;

  if (!isApplicable) {
    return [
      { section: 'trading_performance', score: 0, findings: [], applicable: false },
      { section: 'trading_behavior', score: 0, findings: [], applicable: false },
      { section: 'market_data', score: 0, findings: [], applicable: false },
      { section: 'rate_limits', score: 0, findings: [], applicable: false },
    ];
  }

  const fills = (await readJsonArtifact(store, runId, 'fills.json')) as FillRow[] | null;
  const positions = (await readJsonArtifact(store, runId, 'positions.json')) as PositionRow[] | null;
  const journal = (await readJsonArtifact(store, runId, 'journal.json')) as JournalRow[] | null;

  // ── Trading performance ──────────────────────────────────────────────────
  const perfFindings: EvaluationFinding[] = [];

  if (!fills || fills.length === 0) {
    perfFindings.push(finding('trading_performance', 'info', 'trading.no_activity', 'No trading activity', 'Zero fills recorded in the evaluation scope.'));
  } else {
    // Check for large drawdown via positions
    if (positions && positions.length > 0) {
      const closedPositions = positions.filter((p) => p.closedAt !== null);
      const totalRealizedPnl = closedPositions.reduce((sum, p) => sum + parseFloat(p.realizedPnl), 0);

      // Negative expectancy check (simplified: total realized PnL < 0)
      if (totalRealizedPnl < 0 && thresholds.negativeExpectancyFlag) {
        perfFindings.push(finding('trading_performance', 'medium', 'trading.negative_expectancy', 'Negative trading expectancy', `Total realized PnL across ${closedPositions.length} closed positions is ${totalRealizedPnl.toFixed(2)}.`, 'positions.json'));
      }

      // High drawdown check (simplified: worst realized PnL as fraction of entry notional)
      const maxLossPosition = closedPositions.reduce((worst, p) => {
        const pnl = parseFloat(p.realizedPnl);
        return pnl < (worst ? parseFloat(worst.realizedPnl) : 0) ? p : worst;
      }, null as PositionRow | null);

      if (maxLossPosition && parseFloat(maxLossPosition.realizedPnl) < 0) {
        const lossPct = Math.abs(parseFloat(maxLossPosition.realizedPnl)) / (parseFloat(maxLossPosition.size) * parseFloat(maxLossPosition.entryPrice)) * 100;
        if (lossPct > thresholds.highDrawdownPct) {
          perfFindings.push(finding('trading_performance', 'high', 'trading.high_drawdown', 'High drawdown detected', `Largest losing position (${maxLossPosition.symbol}) lost ${lossPct.toFixed(1)}% of entry notional (threshold: ${thresholds.highDrawdownPct}%).`, `positions.json → id=${maxLossPosition.id}`));
        }
      }
    }

    // Unrealized exposure
    if (positions && positions.length > 0) {
      const openPositions = positions.filter((p) => p.closedAt === null);
      if (openPositions.length > 0) {
        perfFindings.push(finding('trading_performance', 'info', 'trading.open_positions_at_end', 'Open positions at scope end', `${openPositions.length} position(s) remain open at the end of the evaluation scope.`, 'positions.json'));
      }
    }
  }

  // ── Trading behavior ─────────────────────────────────────────────────────
  const behaviorFindings: EvaluationFinding[] = [];

  if (fills && fills.length > 0) {
    // Hold time anomaly (simplified: check if fills are very close together)
    const sortedFills = [...fills].sort((a, b) => new Date(a.filledAt).getTime() - new Date(b.filledAt).getTime());
    if (sortedFills.length >= 2) {
      const firstFill = new Date(sortedFills[0]!.filledAt).getTime();
      const lastFill = new Date(sortedFills[sortedFills.length - 1]!.filledAt).getTime();
      const totalDurationMs = lastFill - firstFill;

      if (totalDurationMs > 0) {
        const avgHoldMs = totalDurationMs / sortedFills.length;
        if (avgHoldMs < thresholds.veryShortHoldSec * 1000) {
          behaviorFindings.push(finding('trading_behavior', 'low', 'trading.very_short_holds', 'Very short average hold time', `Average time between fills is ${(avgHoldMs / 1000).toFixed(1)}s (threshold: ${thresholds.veryShortHoldSec}s). Possible churn.`, 'fills.json'));
        }
      }
    }
  }

  // ── Market data ──────────────────────────────────────────────────────────
  // Level 1: minimal — just flag if fills exist but no journal events about market data
  const mdFindings: EvaluationFinding[] = [];
  // (no market-data-specific checks in Level 1)

  // ── Rate limits ──────────────────────────────────────────────────────────
  const rlFindings: EvaluationFinding[] = [];
  if (journal && journal.length > 0) {
    const rateLimitEvents = journal.filter((e) =>
      e.type?.includes('rate_limit') || e.type?.includes('rate-limit') || e.type?.includes('ratelimit'),
    );
    if (rateLimitEvents.length > thresholds.rateLimitAnomalyCount) {
      rlFindings.push(finding('rate_limits', 'medium', 'trading.rate_limit_anomaly', 'Rate limit anomalies', `${rateLimitEvents.length} rate-limit-related journal events found (threshold: ${thresholds.rateLimitAnomalyCount}).`, 'journal.json'));
    }
  }

  return [
    { section: 'trading_performance', score: computeScore(perfFindings), findings: perfFindings, applicable: true },
    { section: 'trading_behavior', score: computeScore(behaviorFindings), findings: behaviorFindings, applicable: true },
    { section: 'market_data', score: computeScore(mdFindings), findings: mdFindings, applicable: true },
    { section: 'rate_limits', score: computeScore(rlFindings), findings: rlFindings, applicable: true },
  ];
}

function computeScore(findings: EvaluationFinding[]): number {
  const weights: Record<string, number> = { critical: 40, high: 25, medium: 10, low: 5, info: 0 };
  return Math.max(0, 100 - findings.reduce((s, f) => s + (weights[f.severity] ?? 0), 0));
}

import type { Database } from '@herobids/db';
import { FsEvaluationArtifactStore, markSucceeded, markFailed } from '@herobids/db';
import type { ResolvedEvaluationScope, EvaluationRunResult, EvaluationScorecard, EvaluationArtifactStore } from '@herobids/domain';
import type { EvaluationThresholds } from '@herobids/domain';
import { assembleEvidence } from './collectors/evidence-assembler.js';
import { analyzeCore } from './analyzers/core.js';
import { analyzeTrading } from './analyzers/trading.js';
import { analyzeSecurity } from './analyzers/security.js';
import { renderReport } from './render-report.js';
import { redact } from './redaction.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface RunEvaluationContext {
  db: Database;
  runId: string;
  agentId: string;
  resolvedScope: ResolvedEvaluationScope;
  includeNarrative: boolean;
  thresholds: EvaluationThresholds;
  /** Optional store override (defaults to FsEvaluationArtifactStore) */
  store?: EvaluationArtifactStore;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Run a full agent evaluation:
 * 1. Assemble evidence from shared loaders
 * 2. Run deterministic analyzers over collected evidence
 * 3. Compose scorecard
 * 4. Redact and render markdown report
 * 5. Write evaluation.json and REPORT.md to artifact store
 * 6. Mark the run as succeeded in the DB
 *
 * On failure: marks the run as failed in the DB.
 */
export async function runEvaluation(ctx: RunEvaluationContext): Promise<void> {
  const { db, runId, agentId, resolvedScope, includeNarrative, thresholds } = ctx;
  const store = ctx.store ?? new FsEvaluationArtifactStore();

  try {
    // ── Step 1: Assemble evidence ─────────────────────────────────────────
    const manifest = await assembleEvidence({
      db,
      agentId,
      scope: resolvedScope,
      store,
      runId,
    });

    // ── Step 2: Run analyzers ────────────────────────────────────────────
    const coreSections = await analyzeCore(store, runId, manifest, thresholds);
    const tradingSections = await analyzeTrading(store, runId, manifest, thresholds);
    const securitySection = await analyzeSecurity(store, runId);

    // ── Step 3: Compose scorecard ────────────────────────────────────────
    const allSections = [...coreSections, ...tradingSections, securitySection];
    const applicableSections = allSections.filter((s) => s.applicable);
    const overallScore = applicableSections.length > 0
      ? Math.round(applicableSections.reduce((sum, s) => sum + s.score, 0) / applicableSections.length)
      : 100;

    const allFindings = allSections.flatMap((s) => s.findings);
    const criticalCount = allFindings.filter((f) => f.severity === 'critical').length;
    const highCount = allFindings.filter((f) => f.severity === 'high').length;

    const scorecard: EvaluationScorecard = {
      overallScore,
      sections: allSections,
    };

    // ── Step 4: Redact and render ────────────────────────────────────────
    const reportText = renderReport({
      scorecard,
      artifactManifest: [],
      summary: { totalFindings: allFindings.length, criticalCount, highCount },
    });
    const redactedReport = redact(reportText);

    // Level 1: No LLM narrative yet. If includeNarrative, it would be appended here.
    const finalReport = includeNarrative
      ? `${redactedReport}\n\n---\n\n## Commentary\n\n*(LLM narrative not yet implemented — Level 2)*\n`
      : redactedReport;

    // ── Step 5: Write artifacts ──────────────────────────────────────────
    const evaluationJson = {
      scorecard,
      summary: { totalFindings: allFindings.length, criticalCount, highCount },
      manifest: manifest.entries,
      scope: resolvedScope,
      generatedAt: new Date().toISOString(),
    };

    const [evalRef, reportRef] = await Promise.all([
      store.write(runId, 'evaluation.json', JSON.stringify(evaluationJson, null, 2)),
      store.write(runId, 'REPORT.md', finalReport),
    ]);

    // ── Step 6: Persist result ───────────────────────────────────────────
    const result: EvaluationRunResult = {
      scorecard,
      artifactManifest: [evalRef, reportRef],
      summary: { totalFindings: allFindings.length, criticalCount, highCount },
    };

    await markSucceeded(db, runId, result);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await markFailed(db, runId, 'evaluation.internal_error', error.message);
    throw error;
  }
}

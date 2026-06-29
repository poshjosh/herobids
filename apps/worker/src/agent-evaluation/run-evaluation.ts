import { eq } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import {
  agentRuntimeSessions,
  FsEvaluationArtifactStore,
  markSucceeded,
  markFailed,
} from '@herobids/db';
import type { ResolvedEvaluationScope, EvaluationRunResult, EvaluationScorecard, EvaluationArtifactStore } from '@herobids/domain';
import type { EvaluationThresholds } from '@herobids/domain';
import pino from 'pino';
import { assembleEvidence } from './collectors/evidence-assembler.js';
import { analyzeCore } from './analyzers/core.js';
import { analyzeTrading } from './analyzers/trading.js';
import { analyzeSecurity } from './analyzers/security.js';
import { renderReport } from './render-report.js';
import { redact } from './redaction.js';

const logger = pino({ name: 'run-evaluation' });

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
    // ── Step 0: Resolve session timestamps for session-scoped evaluations ─
    let sessionTimestamps: { startedAt: Date; stoppedAt: Date } | undefined;
    if (resolvedScope.type === 'session') {
      const [sess] = await db
        .select({
          startedAt: agentRuntimeSessions.startedAt,
          stoppedAt: agentRuntimeSessions.stoppedAt,
        })
        .from(agentRuntimeSessions)
        .where(eq(agentRuntimeSessions.id, resolvedScope.sessionId))
        .limit(1);
      if (sess?.startedAt && sess?.stoppedAt) {
        sessionTimestamps = { startedAt: sess.startedAt, stoppedAt: sess.stoppedAt };
        logger.info({ runId, sessionId: resolvedScope.sessionId, sessionTimestamps }, 'Resolved session timestamps for evidence filtering');
      } else {
        logger.warn({ runId, sessionId: resolvedScope.sessionId }, 'Session not found or missing timestamps — evidence collection will not be time-filtered');
      }
    }

    // ── Step 1: Assemble evidence ─────────────────────────────────────────
    logger.info({ runId, agentId }, 'Collecting evidence');
    const manifest = await assembleEvidence({
      db,
      agentId,
      scope: resolvedScope,
      store,
      runId,
      sessionTimestamps,
    });
    logger.info({ runId, entries: manifest.entries.filter((e) => e.collected).length }, 'Evidence collected');

    // ── Step 2: Run analyzers ────────────────────────────────────────────
    logger.info({ runId }, 'Running core analyzer');
    const coreSections = await analyzeCore(store, runId, manifest, thresholds);

    logger.info({ runId }, 'Running trading analyzer');
    const tradingSections = await analyzeTrading(store, runId, manifest, thresholds);

    logger.info({ runId }, 'Running security analyzer');
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
    logger.info({ runId, totalFindings: allFindings.length, criticalCount, highCount }, 'Rendering report');
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

    // Build the full artifact manifest: evidence artifacts from the store +
    // the evaluation.json and REPORT.md we just wrote. This ensures the
    // download route can resolve MIME types for all artifacts, not just the
    // two we explicitly write here.
    const storeArtifacts = await store.list(runId);
    const fullManifest = [
      evalRef,
      reportRef,
      ...storeArtifacts.filter(
        (a) => a.name !== evalRef.name && a.name !== reportRef.name,
      ),
    ];

    // ── Step 6: Persist result ───────────────────────────────────────────
    logger.info({ runId, overallScore: scorecard.overallScore, artifactCount: fullManifest.length }, 'Persisting evaluation result');
    const result: EvaluationRunResult = {
      scorecard,
      artifactManifest: fullManifest,
      summary: { totalFindings: allFindings.length, criticalCount, highCount },
    };

    await markSucceeded(db, runId, result);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await markFailed(db, runId, 'evaluation.internal_error', error.message);
    throw error;
  }
}

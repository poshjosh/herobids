import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import type { Database } from '@herobids/db';
import {
  agentRuntimeSessions,
  FsEvaluationArtifactStore,
  markSucceeded,
  markFailed,
  markRetrying,
  agents,
  billingAccounts,
  type UsageBillingRepository,
  type InsertUsageEvent,
} from '@herobids/db';
import type { ResolvedEvaluationScope, EvaluationRunResult, EvaluationScorecard, EvaluationArtifactStore, EvaluationThresholds } from '@herobids/domain';
import type { ResolvedNarrativeLlmConfig } from '@herobids/db';
import pino from 'pino';
import { assembleEvidence } from './collectors/evidence-assembler.js';
import { analyzeCore } from './analyzers/core.js';
import { analyzeTrading } from './analyzers/trading.js';
import { analyzeSecurity } from './analyzers/security.js';
import { renderReport } from './render-report.js';
import { generateEvaluationNarrative } from './generate-narrative.js';
import { redact, redactJson } from './redaction.js';

const logger = pino({ name: 'run-evaluation' });

// ── Types ───────────────────────────────────────────────────────────────────

export interface RunEvaluationContext {
  db: Database;
  runId: string;
  agentId: string;
  resolvedScope: ResolvedEvaluationScope;
  includeNarrative: boolean;
  /** Fully resolved narrative LLM config (present when narrative is enabled and resolution succeeded). */
  narrativeLlm?: ResolvedNarrativeLlmConfig;
  thresholds: EvaluationThresholds;
  /** Optional store override (defaults to FsEvaluationArtifactStore) */
  store?: EvaluationArtifactStore;
  /** Root directory for evaluation artifacts (from operator config). */
  storageRoot: string;
  /** Current attempt number (1-based, from BullMQ). Used for retry decisions. */
  attemptNumber: number;
  /** Max total attempts for this job. attemptNumber === maxAttempts means last try. */
  maxAttempts: number;
  /** Optional Redis client for snapshot collection (best-effort, future wiring). */
  redis?: { snapshot: () => Promise<Record<string, unknown>> };
  /** Optional billing repository for recording narrative LLM usage */
  usageBillingRepo?: UsageBillingRepository;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Run a full agent evaluation:
 * 1. Assemble evidence from shared loaders (raw, unredacted)
 * 2. Run deterministic analyzers over raw evidence (security analyzer needs raw data)
 * 3. Redact evidence artifacts for user-facing output
 * 4. Compose scorecard
 * 5. Render markdown report (redacted)
 * 6. Write evaluation.json and REPORT.md to artifact store
 * 7. Mark the run as succeeded in the DB
 *
 * On failure:
 * - If retries remain: markRetrying (reset to queued, increment attempt)
 * - If last attempt: markFailed (permanent failure)
 */
export async function runEvaluation(ctx: RunEvaluationContext): Promise<void> {
  const { db, runId, agentId, resolvedScope, includeNarrative, thresholds } = ctx;
  const store = ctx.store ?? new FsEvaluationArtifactStore(ctx.storageRoot);

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
        throw new Error(
          `Session ${resolvedScope.sessionId} not found or missing timestamps — cannot scope evaluation. ` +
          `The session may have been deleted or is still running.`,
        );
      }
    }

    // ── Step 1: Assemble evidence (raw, unredacted) ───────────────────────
    logger.info({ runId, agentId }, 'Collecting evidence');
    const manifest = await assembleEvidence({
      db,
      agentId,
      scope: resolvedScope,
      store,
      runId,
      sessionTimestamps,
      redis: ctx.redis,
    });
    logger.info({ runId, entries: manifest.entries.filter((e) => e.collected).length }, 'Evidence collected');

    // ── Step 2: Run analyzers over RAW evidence ──────────────────────────
    // Security analyzer must run BEFORE redaction so it can detect secrets.
    logger.info({ runId }, 'Running security analyzer (pre-redaction)');
    const securitySection = await analyzeSecurity(store, runId);

    logger.info({ runId }, 'Running core analyzer');
    const coreSections = await analyzeCore(store, runId, manifest, thresholds);

    logger.info({ runId }, 'Running trading analyzer');
    const tradingSections = await analyzeTrading(store, runId, manifest, thresholds);

    // ── Step 3: Redact evidence artifacts for user-facing output ──────────
    // Now that all analyzers have read the raw evidence, redact the stored
    // artifacts so downloaded files never contain raw secrets.
    const evidenceArtifacts = ['fills.json', 'journal.json', 'sessions.json', 'positions.json', 'agent-metadata.json', 'unified-agent-config.json'];
    for (const name of evidenceArtifacts) {
      try {
        const raw = await store.read(runId, name);
        if (raw) {
          const parsed = JSON.parse(new TextDecoder().decode(raw));
          const redacted = redactJson(parsed);
          await store.write(runId, name, JSON.stringify(redacted, null, 2));
        }
      } catch {
        // If an artifact can't be redacted, leave it as-is — it's better
        // than failing the entire evaluation at this late stage.
        logger.warn({ runId, artifact: name }, 'Could not redact evidence artifact — leaving as-is');
      }
    }

    // ── Step 4: Compose scorecard ────────────────────────────────────────
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

    // ── Step 5: Render redacted markdown report ──────────────────────────
    logger.info({ runId, totalFindings: allFindings.length, criticalCount, highCount }, 'Rendering report');
    const reportText = renderReport({
      scorecard,
      artifactManifest: [],
      summary: { totalFindings: allFindings.length, criticalCount, highCount },
    });
    const redactedReport = redact(reportText);

    // ── Step 5b: Generate LLM narrative commentary (best-effort) ────────
    let narrativeText: string | null = null;
    if (includeNarrative && ctx.narrativeLlm) {
      const narrativeResult = await generateEvaluationNarrative(
        ctx.narrativeLlm,
        store,
        runId,
      );

      // Write narrative metadata artifact (always, even on failure)
      try {
        await store.write(
          runId,
          'narrative-metadata.json',
          JSON.stringify(narrativeResult.metadata, null, 2),
        );
      } catch {
        logger.warn({ runId }, 'Could not write narrative metadata artifact');
      }

      // Record billing usage on successful generation
      if (narrativeResult.text && narrativeResult.metadata.tokensUsed > 0 && ctx.usageBillingRepo) {
        try {
          // Get agent info for billing — read user ID
          const [agentRow] = await db
            .select({ userId: agents.userId })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1);

          if (agentRow) {
            // Get billing account for this user
            const [billingAccount] = await db
              .select({ id: billingAccounts.id })
              .from(billingAccounts)
              .where(eq(billingAccounts.ownerUserId, agentRow.userId))
              .limit(1);

            if (billingAccount) {
              const events: InsertUsageEvent[] = [];
              const base = {
                accountId: billingAccount.id,
                userId: agentRow.userId,
                agentId,
                sourceType: 'evaluation_narrative',
                provider: narrativeResult.metadata.provider,
                model: narrativeResult.metadata.model,
                unit: 'tokens',
                occurredAt: new Date(),
              };

              if (narrativeResult.metadata.inputTokens != null && narrativeResult.metadata.outputTokens != null) {
                // Granular breakdown available — record input and output separately
                events.push({
                  ...base,
                  id: crypto.randomUUID(),
                  meterKey: 'llm.input_tokens',
                  quantity: narrativeResult.metadata.inputTokens,
                  idempotencyKey: `eval-narrative-input-${runId}`,
                  metadata: { latencyMs: narrativeResult.metadata.latencyMs },
                });
                events.push({
                  ...base,
                  id: crypto.randomUUID(),
                  meterKey: 'llm.output_tokens',
                  quantity: narrativeResult.metadata.outputTokens,
                  idempotencyKey: `eval-narrative-output-${runId}`,
                  metadata: { latencyMs: narrativeResult.metadata.latencyMs },
                });
              } else {
                // Total-only fallback (matches usage-billing-service.ts convention)
                events.push({
                  ...base,
                  id: crypto.randomUUID(),
                  meterKey: 'llm.output_tokens',
                  quantity: narrativeResult.metadata.tokensUsed,
                  idempotencyKey: `eval-narrative-${runId}`,
                  metadata: {
                    granularity: 'total_only',
                    latencyMs: narrativeResult.metadata.latencyMs,
                  },
                });
              }

              await ctx.usageBillingRepo.recordUsageEvents(events);
              logger.info({ runId, tokensUsed: narrativeResult.metadata.tokensUsed, eventCount: events.length }, 'Narrative usage billed');
            }
          }
        } catch (err) {
          logger.warn({ runId, err: (err as Error)?.message }, 'Could not record narrative usage billing');
        }
      }

      // Redact the generated narrative before writing it
      if (narrativeResult.text) {
        narrativeText = redact(narrativeResult.text);
      }
    }

    const finalReport = narrativeText
      ? `${redactedReport}\n\n---\n\n## Commentary\n\n${narrativeText}\n`
      : redactedReport;

    // ── Step 6: Write evaluation.json and REPORT.md ──────────────────────
    const result: EvaluationRunResult = {
      scorecard,
      artifactManifest: [], // filled after we know all written artifacts
      summary: { totalFindings: allFindings.length, criticalCount, highCount },
    };

    const evaluationJson = {
      ...result,
      scope: resolvedScope,
      generatedAt: new Date().toISOString(),
    };

    const [evalRef, reportRef] = await Promise.all([
      store.write(runId, 'evaluation.json', JSON.stringify(evaluationJson, null, 2)),
      store.write(runId, 'REPORT.md', finalReport),
    ]);

    // Build the full artifact manifest: evidence artifacts from the store +
    // the evaluation.json and REPORT.md we just wrote.
    const storeArtifacts = await store.list(runId);
    const fullManifest = [
      evalRef,
      reportRef,
      ...storeArtifacts.filter(
        (a) => a.name !== evalRef.name && a.name !== reportRef.name,
      ),
    ];

    // ── Step 7: Persist result ───────────────────────────────────────────
    result.artifactManifest = fullManifest;
    logger.info({ runId, overallScore: scorecard.overallScore, artifactCount: fullManifest.length }, 'Persisting evaluation result');
    await markSucceeded(db, runId, result);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // Retry decision: if we have remaining attempts, reset to queued so
    // BullMQ's retry mechanism can re-deliver the job. Otherwise, mark as
    // permanently failed.
    const isRetryable = ctx.attemptNumber < ctx.maxAttempts;
    if (isRetryable) {
      logger.warn({ runId, attempt: ctx.attemptNumber, maxAttempts: ctx.maxAttempts, err: error.message }, 'Evaluation failed — retrying');
      await markRetrying(db, runId, 'evaluation.internal_error', error.message);
    } else {
      logger.error({ runId, attempt: ctx.attemptNumber, err: error.message }, 'Evaluation failed — final attempt exhausted');
      await markFailed(db, runId, 'evaluation.internal_error', error.message);
    }
    throw error;
  }
}

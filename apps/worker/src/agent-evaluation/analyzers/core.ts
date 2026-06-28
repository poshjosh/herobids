import type { EvaluationArtifactStore, EvaluationSectionScore, EvaluationFinding, EvaluationSeverity } from '@herobids/domain';
import type { EvaluationThresholds } from '@herobids/domain';
import type { EvidenceManifest } from '../collectors/evidence-assembler.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function finding(
  section: EvaluationSectionScore['section'],
  severity: EvaluationSeverity,
  code: string,
  title: string,
  detail: string,
  evidence?: string,
): EvaluationFinding {
  return { section, severity, code, title, detail, evidence };
}

function sectionScore(
  section: EvaluationSectionScore['section'],
  findings: EvaluationFinding[],
  applicable = true,
): EvaluationSectionScore {
  const score = applicable ? Math.max(0, 100 - findings.reduce((s, f) => {
    const weights: Record<EvaluationSeverity, number> = { critical: 40, high: 25, medium: 10, low: 5, info: 0 };
    return s + (weights[f.severity] ?? 0);
  }, 0)) : 0;
  return { section, score, findings, applicable };
}

async function readJsonArtifact(store: EvaluationArtifactStore, runId: string, name: string): Promise<unknown> {
  const data = await store.read(runId, name);
  if (!data) return null;
  return JSON.parse(new TextDecoder().decode(data));
}

// ── Core analyzer ───────────────────────────────────────────────────────────

/**
 * Core analyzer — always runs for every agent.
 * Checks session health, tool failures, cost visibility, persistence, and runtime duration.
 */
export async function analyzeCore(
  store: EvaluationArtifactStore,
  runId: string,
  manifest: EvidenceManifest,
  thresholds: EvaluationThresholds,
): Promise<EvaluationSectionScore[]> {
  const sections: EvaluationSectionScore[] = [];

  // ── Session health ──────────────────────────────────────────────────────
  const sessionFindings: EvaluationFinding[] = [];
  const sessions = await readJsonArtifact(store, runId, 'sessions.json') as Array<Record<string, unknown>> | null;

  if (!sessions || sessions.length === 0) {
    sessionFindings.push(finding('session_health', 'critical', 'core.no_sessions', 'No runtime sessions found', 'The agent has no recorded runtime sessions in the evaluation scope. The agent may not have been started or session recording is broken.'));
  } else {
    for (const s of sessions) {
      if (s['status'] === 'crashed') {
        sessionFindings.push(finding('session_health', 'high', 'core.session_crashed', 'Session crashed', `Session ${s['id']} ended with status 'crashed'.`, `sessions.json → id=${s['id']}`));
      }
    }
    // Check for very short sessions
    for (const s of sessions) {
      const startedAt = s['startedAt'] ? new Date(s['startedAt'] as string) : null;
      const stoppedAt = s['stoppedAt'] ? new Date(s['stoppedAt'] as string) : null;
      if (startedAt && stoppedAt) {
        const durationMs = stoppedAt.getTime() - startedAt.getTime();
        if (durationMs < thresholds.veryShortSessionSec * 1000) {
          sessionFindings.push(finding('session_health', 'info', 'core.very_short_session', 'Very short session', `Session ${s['id']} lasted ${Math.round(durationMs / 1000)}s (< ${thresholds.veryShortSessionSec}s threshold).`, `sessions.json → id=${s['id']}`));
        }
      }
    }
  }
  sections.push(sectionScore('session_health', sessionFindings));

  // ── Tool usage ──────────────────────────────────────────────────────────
  const toolFindings: EvaluationFinding[] = [];
  const journal = await readJsonArtifact(store, runId, 'journal.json') as Array<Record<string, unknown>> | null;

  if (journal && journal.length > 0) {
    const toolEvents = journal.filter((e) => {
      const type = e['type'] as string;
      return type?.startsWith('tool.') || type?.includes('failure') || type?.includes('error');
    });
    const totalEvents = journal.length;
    const failureRate = totalEvents > 0 ? toolEvents.length / totalEvents : 0;
    if (failureRate * 100 > thresholds.toolFailureRatePct) {
      toolFindings.push(finding('tool_usage', 'medium', 'core.high_tool_failure_rate', 'High tool failure rate', `${(failureRate * 100).toFixed(1)}% of journal events are tool failures (threshold: ${thresholds.toolFailureRatePct}%).`, `journal.json → ${toolEvents.length} tool failures out of ${totalEvents} events`));
    }
  }
  sections.push(sectionScore('tool_usage', toolFindings));

  // ── Cost ────────────────────────────────────────────────────────────────
  const costFindings: EvaluationFinding[] = [];
  const costEntry = manifest.entries.find((e) => e.artifactName === 'costs.json');
  if (!costEntry?.collected) {
    costFindings.push(finding('cost', 'low', 'core.no_cost_data', 'No cost data available', 'Agent-level billing/cost data could not be collected.'));
  }
  sections.push(sectionScore('cost', costFindings));

  // ── Persistence ─────────────────────────────────────────────────────────
  const persistFindings: EvaluationFinding[] = [];
  if (!journal || journal.length === 0) {
    persistFindings.push(finding('persistence', 'medium', 'core.no_journal_entries', 'No journal entries found', 'The agent has no journal events in the evaluation scope. This may indicate the persistence layer is not recording events.'));
  }
  sections.push(sectionScore('persistence', persistFindings));

  return sections;
}

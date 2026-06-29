import type { EvaluationRunResult } from '@herobids/domain';

// ── Severity emoji ──────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: '⚪',
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

// ── Section labels ──────────────────────────────────────────────────────────

const SECTION_LABELS: Record<string, string> = {
  session_health: 'Session Health',
  tool_usage: 'Tool Usage',
  cost: 'Cost',
  security: 'Security',
  persistence: 'Persistence',
  trading_performance: 'Trading Performance',
  trading_behavior: 'Trading Behavior',
  market_data: 'Market Data',
  rate_limits: 'Rate Limits',
};

// ── Render ──────────────────────────────────────────────────────────────────

/**
 * Render a deterministic Markdown report from an evaluation scorecard.
 * No LLM required — pure function from structured data to markdown.
 */
export function renderReport(result: EvaluationRunResult): string {
  const { scorecard, summary } = result;
  const lines: string[] = [];

  // ── Header ─────────────────────────────────────────────────────────────
  lines.push('# Agent Evaluation Report');
  lines.push('');
  lines.push(`**Overall Score:** ${scorecard.overallScore}/100`);
  lines.push('');
  lines.push(`**Findings:** ${summary.totalFindings} total (🔴 ${summary.criticalCount} critical, 🟠 ${summary.highCount} high)`);
  lines.push('');

  // ── Sections ───────────────────────────────────────────────────────────
  for (const section of scorecard.sections) {
    const label = SECTION_LABELS[section.section] ?? section.section;

    if (!section.applicable) {
      lines.push(`## ${label} *(not applicable)*`);
      lines.push('');
      lines.push('_This section was skipped because it does not apply to this agent type._');
      lines.push('');
      continue;
    }

    lines.push(`## ${label} — Score: ${section.score}/100`);
    lines.push('');

    if (section.findings.length === 0) {
      lines.push('✅ No issues detected.');
      lines.push('');
      continue;
    }

    // Sort by severity
    const sorted = [...section.findings].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );

    for (const f of sorted) {
      const icon = SEVERITY_ICON[f.severity] ?? '⚪';
      lines.push(`### ${icon} ${f.title}`);
      lines.push('');
      lines.push(`- **Severity:** ${f.severity}`);
      lines.push(`- **Code:** \`${f.code}\``);
      lines.push(`- **Detail:** ${f.detail}`);
      if (f.evidence) {
        lines.push(`- **Evidence:** ${f.evidence}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

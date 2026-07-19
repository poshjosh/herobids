import type { PresetAssessmentSummary } from './preset-assessment-summary.js';

/**
 * Render the Preset Assessment Summary appendix as deterministic markdown.
 * Returns an empty string when the summary is not included in the report.
 */
export function renderPresetAssessmentAppendix(
  summary: PresetAssessmentSummary,
): string {
  if (!summary.includedInReport) return '';

  const lines: string[] = [];
  const { configSnapshot, answers, reviewAdvice, assessmentRequests, presetTransitions, currentDefaultBinding } = summary;

  // ── Header ──────────────────────────────────────────────────────────
  lines.push('## Preset Assessment Summary');
  lines.push('');
  lines.push(`- Inclusion reason: ${summary.inclusionReason}`);
  lines.push('- Scope note: current config snapshot + in-scope preset-assessment activity');
  lines.push('');

  // ── 1. Feature Enablement ───────────────────────────────────────────
  lines.push('### 1. Feature Enablement');
  lines.push(`- Answer: ${answers.featureEnabled.status}`);
  lines.push(`- Current opt-in flag: ${configSnapshot.platformAssessmentEnabled ?? 'unknown'}`);
  lines.push(`- Style tier: ${configSnapshot.styleTier ?? 'unknown'}`);
  lines.push(`- Allowed presets: ${formatList(configSnapshot.allowedPresets)}`);
  lines.push(`- Allowed transition modes: ${formatList(configSnapshot.allowedTransitionModes)}`);
  lines.push(`- Supported apply transition modes in this release: ${formatList(configSnapshot.supportedApplyTransitionModes)}`);
  lines.push(`- Note: current config snapshot only; historical enablement is not versioned here`);
  lines.push('');

  // ── 2. Review Advice ────────────────────────────────────────────────
  lines.push('### 2. Review Advice');
  lines.push(`- Answer: ${answers.reviewAdviceReceived.status}`);
  lines.push(`- Advice rows in scope: ${reviewAdvice.totalRows}`);
  lines.push(`- Advised rows: ${reviewAdvice.advisedRows}`);
  lines.push(`- Consumed advice rows: ${reviewAdvice.consumedRows}`);
  const outcomes = reviewAdvice.outcomes;
  lines.push(`- Suppression breakdown: not_advised=${outcomes.not_advised}, blocked_by_cooldown=${outcomes.blocked_by_cooldown}, blocked_by_no_credit_indication=${outcomes.blocked_by_no_credit_indication}, fresh_artifact_exists=${outcomes.fresh_artifact_exists}, no_candidate=${outcomes.no_candidate}`);
  lines.push(`- Top advised identities: ${formatList(reviewAdvice.topAdvisedIdentities)}`);
  lines.push('');

  // ── 3. Assessment Requests And Reuse ────────────────────────────────
  lines.push('### 3. Assessment Requests And Reuse');
  lines.push(`- Answer: ${answers.assessmentRequestsAndReuse.status}`);
  lines.push(`- Requests in scope: ${assessmentRequests.totalRows}`);
  lines.push(`- Successful fresh runs: ${assessmentRequests.successfulFreshRuns}`);
  lines.push(`- Successful cache hits: ${assessmentRequests.successfulCacheHits}`);
  lines.push(`- Billing blocked: ${assessmentRequests.billingBlocked}`);
  lines.push(`- Cooldown blocked: ${assessmentRequests.cooldownBlocked}`);
  lines.push(`- Provider failed: ${assessmentRequests.providerFailed}`);
  lines.push(`- Reuse definition: cache_hit only`);
  lines.push(`- Last successful artifact: ${assessmentRequests.lastSuccessfulArtifactId ?? 'none'}`);
  lines.push('');

  // ── 4. Preset Changes ───────────────────────────────────────────────
  lines.push('### 4. Preset Changes');
  lines.push(`- Answer: ${answers.presetChangesCleanAndAuditable.status}`);
  lines.push(`- Transition rows in scope: ${presetTransitions.totalRows}`);
  lines.push(`- Applied: ${presetTransitions.applied}`);
  lines.push(`- Deferred: ${presetTransitions.deferred}`);
  lines.push(`- Rejected: ${presetTransitions.rejected}`);
  lines.push(`- Failed or partially applied: ${presetTransitions.failed + presetTransitions.partiallyApplied}`);
  lines.push(`- Modes observed: ${formatList(presetTransitions.modesObserved)}`);
  const last = presetTransitions.lastAppliedTransition;
  if (last) {
    lines.push(`- Last applied transition: ${last.oldPresetKey} -> ${last.newPresetKey} via ${last.transitionMode}`);
  } else {
    lines.push('- Last applied transition: none');
  }
  lines.push('');

  // ── Evidence Notes ──────────────────────────────────────────────────
  lines.push('### Evidence Notes');
  const binding = currentDefaultBinding;
  const bindingInfo = binding.activePresetKey
    ? `${binding.activePresetKey} (behavior: ${binding.behaviorVersion ?? '?'})`
    : 'unknown';
  lines.push(`- Current active default preset binding: ${bindingInfo}`);
  lines.push(`- Identity-scoped transitions observed in scope: ${summary.identityScopedTransitionsObserved ? 'yes' : 'no'}`);
  if (summary.auditCaveats.length > 0) {
    lines.push('- Audit caveats:');
    for (const caveat of summary.auditCaveats) {
      lines.push(`  - ${caveat}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function formatList(items: string[] | null | undefined): string {
  if (!items || items.length === 0) return 'not configured';
  return items.join(', ');
}

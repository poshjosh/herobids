import type { ScannerWakeContext } from '@herobids/domain';

/**
 * Build a user-facing message for an assessment_review scanner wake.
 *
 * Presents the deterministic scanner pre-check results to the agent so it can
 * decide whether to request a full market assessment via
 * get_market_preset_assessment. The advice is purely informational — no
 * billing, no assessor invocation, no artifact creation occurs from the wake
 * alone.
 */
export function buildAssessmentReviewMessage(
  ctx: ScannerWakeContext & { scannerKind: 'assessment_review' },
): string {
  const adviceLines = ctx.advice.map((a) => {
    const identityDesc = a.identity.instrumentKind === 'swap' || a.identity.instrumentKind === 'dex'
      ? `${a.identity.network}/${a.identity.address}`
      : a.identity.symbol ?? 'unknown';
    const reasons = a.reasons.join(', ');
    return `- **#${a.candidateRank}** \`${identityDesc}\` (${a.identity.venueFamily}, ${a.identity.styleTier}) — ${reasons}
  Active Preset: \`${a.activePreset}\` (v${a.presetBehaviorVersion})`;
  });

  const lines: string[] = [
    '🔔 **Assessment Review Available**',
    '',
    `The platform scanner ran a deterministic pre-check at \`${ctx.checkedAt}\` and found **${ctx.advice.length}** symbol(s) where your current preset may be sub-optimal for current market conditions.`,
    '',
    '**Candidates:**',
    ...adviceLines,
    '',
    '**What to do:**',
    '- Use `get_market_preset_assessment` to request a full assessment for any candidate symbol.',
    '  This is a **billable action** — each assessment request incurs a charge.',
    '- If the assessment returns a strong recommendation, use `recommend_preset_transition` to evaluate a preset switch.',
    '- Use `apply_preset_transition` to apply the change (if you agree with the recommendation).',
    '',
    `Next review eligible after: \`${ctx.nextEligibleAt}\``,
    '',
    '**Important:** This is an informational review — no assessment has been run, and no billing has occurred.',
    'You are the final decision-maker. Consider your open positions, recent performance, and risk limits before acting.',
  ];
  return lines.join('\n');
}

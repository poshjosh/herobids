import type { ScannerWakeContext } from '@herobids/domain';

/**
 * Build a user-facing message for an assessment_review scanner wake.
 *
 * Presents the deterministic scanner pre-check results to the agent so it can
 * decide whether to request a full market assessment via
 * `assess_strategy_preset`. The advice is purely informational — no
 * billing, no assessor invocation, no artifact creation occurs from the wake
 * alone.
 */
export function buildAssessmentReviewMessage(
  ctx: ScannerWakeContext & { scannerKind: 'assessment_review' },
): string {
  const adviceLines = ctx.advice.map((a) => {
    const identityDesc = a.identity.instrumentKind === 'swap' || a.identity.instrumentKind === 'dex'
      ? `${a.identity.network}/${a.identity.address}`
      : 'symbol' in a.identity ? (a.identity.symbol ?? 'unknown') : 'unknown';
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
    '- Use `assess_strategy_preset` to request a full assessment for one or more candidate symbols.',
    '  Pass multiple symbols in one call (e.g. `["BTC", "ETH"]`) — each assessed symbol incurs a charge.',
    '  The tool returns ranked presets, confidence scores, and the exact reference needed for `change_strategy_preset`.',
    '- Use `change_strategy_preset` to apply the recommended preset switch for any assessed symbol.',
    '',
    `Next review eligible after: \`${ctx.nextEligibleAt}\``,
    '',
    '**Important:** This is an informational review — no assessment has been run, and no billing has occurred.',
    'You are the final decision-maker. Consider your open positions, recent performance, and risk limits before acting.',
  ];
  return lines.join('\n');
}

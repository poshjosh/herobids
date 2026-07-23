import type { ScannerWakeContext } from '@herobids/domain';

/**
 * Build a user-facing message for an assessment_review scanner wake.
 *
 * This is the **active** assessment-review prompt. The review scheduler
 * (`AssessmentReviewRunner`) emits `scannerKind: 'assessment_review'` wakes
 * after a deterministic pre-check. The agent must call `assess_strategy_preset`
 * to get a full ranked assessment (with `allowedPresets`, `freshnessNote`, and
 * the `assessmentArtifactId` needed by `change_strategy_preset`) before acting.
 *
 * No billing, no assessor invocation, and no artifact creation occurs from the
 * wake alone — it is purely informational.
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
    '1. Call `assess_strategy_preset` for one or more candidate symbols (e.g. `["BTC", "ETH"]`).',
    '   ⚠️ Each assessed symbol incurs a billing charge. Pass multiple symbols in one call when possible.',
    '2. The response includes, for each symbol:',
    '   - `rankings` — all presets with scores, pros, and cons',
    '   - `allowedPresets` — the subset of presets eligible for `change_strategy_preset`',
    '   - `recommendedPreset` — the top-ranked preset (if confidence/score thresholds are met)',
    '   - `freshnessNote` and `expiresAt` — how long the artifact is valid; you must act before expiry',
    '   - `assessmentArtifactId` — the exact reference required by `change_strategy_preset`',
    '3. Pick a target preset from `allowedPresets`, then call `change_strategy_preset` with the exact `assessmentArtifactId`.',
    '   - If the artifact expires before you act, request a fresh assessment.',
    '   - If `change_strategy_preset` rejects your target, the error will list the allowed presets — pick one and retry.',
    '',
    `Next review eligible after: \`${ctx.nextEligibleAt}\``,
    '',
    '**Important:** This is an informational review — no assessment has been run, and no billing has occurred.',
    'You are the final decision-maker. Consider your open positions, recent performance, and risk limits before acting.',
  ];
  return lines.join('\n');
}

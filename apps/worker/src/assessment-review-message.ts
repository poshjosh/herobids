import type { ScannerWakeContext } from '@herobids/domain';

/**
 * Build a user-facing message for an assessment_review scanner wake (H4).
 *
 * The pre-check is now run by Traderton (plan 004 S7): Traderton evaluates
 * herobids' own deterministic pre-check over its scan candidates and, on a
 * positive result, writes an `agent_wake` notification with
 * `context.scannerKind === 'assessment_review'`. Herobids only delivers the
 * wake and builds the text. There is no billing and no platform assessor run —
 * the agent calls `assess_strategy_preset` (now a Traderton data-only tool)
 * and reads the flags per the skill guidance.
 */
export function buildAssessmentReviewMessage(
  ctx: ScannerWakeContext & { scannerKind: 'assessment_review' },
): string {
  const adviceLines = ctx.advice.map((a) => {
    const identityDesc = resolveIdentityDesc(a.identity);
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
    '1. Call `assess_strategy_preset` for one or more candidate symbols (e.g. `["BTC", "ETH"]`). Assessment is now data-only and free.',
    '2. Read the flags per symbol per preset: `creatorAllowed`, `evidenceFresh`, `regimeMatch`, `signalsVsCurrent`. More signals is NOT better fit.',
    '3. Change your preset with `change_strategy_preset` only when the data clearly shows a better fit, and give a reason (it is shown on the review screen).',
    '',
    `Next review eligible after: \`${ctx.nextEligibleAt}\``,
    '',
    '**Important:** This is an informational review — no assessment has been run. You are the final decision-maker.',
  ];
  return lines.join('\n');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type AdviceIdentity = {
  symbol?: string;
  network?: string;
  address?: string;
  instrumentKind: string;
  venueFamily: string;
  styleTier: string;
};

function resolveIdentityDesc(identity: AdviceIdentity): string {
  if (identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex') {
    return `${identity.network}/${identity.address}`;
  }
  if (identity.symbol) {
    return identity.symbol;
  }
  return 'unknown';
}

import type { ScannerWakeContext } from '@herobids/domain';

/**
 * Build a user-facing message for an assessment_review scanner wake.
 *
 * Two paths:
 * 1. **Artifact path (manual/forced review):** When any advice entry carries an
 *    `assessmentArtifactId` (from a synchronous platform assessment that was
 *    already run and billed as part of a user-triggered review), the message
 *    tells the agent to call `change_strategy_preset` directly — no second
 *    billed call needed for the artifacts listed.
 * 2. **Scheduled path (no artifacts):** The existing informational message
 *    telling the agent to call `assess_strategy_preset` first. No assessment
 *    has been run, and no billing has occurred from the wake alone.
 */
export function buildAssessmentReviewMessage(
  ctx: ScannerWakeContext & { scannerKind: 'assessment_review' },
): string {
  const hasArtifacts = ctx.advice.some((a) => a.assessmentArtifactId);

  if (hasArtifacts) {
    return buildArtifactMessage(ctx);
  }

  // ── Scheduled path — keep existing message exactly unchanged ──────────

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

/** Artifact-first message for manual/forced reviews where assessments already ran. */
function buildArtifactMessage(
  ctx: ScannerWakeContext & { scannerKind: 'assessment_review' },
): string {
  const totalCount = ctx.advice.length;
  const assessedCount = ctx.advice.filter((a) => a.assessmentArtifactId).length;

  const resultLines = ctx.advice.map((a) => {
    const identityDesc = resolveIdentityDesc(a.identity);

    if (a.assessmentArtifactId) {
      const recommended = a.recommendedPreset ? `**${a.recommendedPreset}**` : 'none';
      const confidence = a.confidence != null ? `${a.confidence}` : 'unknown';
      return [
        `- **#${a.candidateRank}** \`${identityDesc}\` (${a.identity.venueFamily}, ${a.identity.styleTier})`,
        `  Current: \`${a.activePreset}\` → Recommended: ${recommended} (confidence: ${confidence})`,
        `  Artifact: \`${a.assessmentArtifactId}\` — expires \`${a.expiresAt ?? 'unknown'}\``,
      ].join('\n');
    }

    // Pre-check advised but not assessed in this batch (e.g. over the cap)
    return `- **#${a.candidateRank}** \`${identityDesc}\` (${a.identity.venueFamily}, ${a.identity.styleTier}) — pre-check advised but not assessed in this batch. Call \`assess_strategy_preset\` to get a full assessment for this symbol.`;
  });

  const billingNote = assessedCount < totalCount
    ? ` Assessment results are ready for ${assessedCount} of ${totalCount} symbols — no further billing is needed for the artifacts below.`
    : ' Assessment results are ready — no further billing is needed for the artifacts below.';

  const lines: string[] = [
    '🔔 **Strategy Assessment Complete**',
    '',
    `The platform ran a deterministic pre-check and a market assessment at \`${ctx.checkedAt}\` for **${totalCount}** symbol(s).${billingNote}`,
    '',
    '**Results:**',
    ...resultLines,
    '',
    '**What to do:**',
    '1. Review the recommendation for each symbol above.',
    '2. To apply a switch, call `change_strategy_preset` with the exact `assessmentArtifactId` shown and your chosen `targetPreset` (must be one of the artifact\'s allowed presets).',
    '3. If an artifact has expired by the time you act, call `assess_strategy_preset` again for a fresh one (this will incur a new charge).',
    '',
    `Next review eligible after: \`${ctx.nextEligibleAt}\``,
    '',
    '**Important:** These assessments were already billed by a user-triggered review. You are the final decision-maker. Consider your open positions, recent performance, and risk limits before acting. No further billing occurs for the artifacts listed above.',
  ];
  return lines.join('\n');
}

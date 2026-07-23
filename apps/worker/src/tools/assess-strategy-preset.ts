import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import {
  AssessStrategyPresetParamsSchema,
  AssessStrategyPresetResponseSchema,
  type AssessmentResultEntry,
  type AssessStrategyPresetResponse,
} from '@herobids/domain';
import type {
  AssessmentRequestPort,
  AssessmentRequestPortParams,
  AssessmentRequestPortOutcome,
} from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { createLogger } from '../logger.js';

const logger = createLogger('tool:assess-strategy-preset');

// ── Module-level port reference ────────────────────────────────────────────

let port: AssessmentRequestPort | null = null;

export function setAssessmentRequestPort(p: AssessmentRequestPort): void {
  port = p;
}

/**
 * Compute a human-readable freshness note from an ISO expiry timestamp.
 * Gives the agent a clear, actionable signal about the time window for
 * acting on the assessment before it expires.
 */
export function computeFreshnessNote(expiresAt: string): string {
  const expiresAtDate = new Date(expiresAt);
  const minutesRemaining = Math.round((expiresAtDate.getTime() - Date.now()) / 60_000);
  if (minutesRemaining <= 0) {
    return 'This assessment has already expired. Request a fresh assessment via assess_strategy_preset before applying any transition.';
  }
  if (minutesRemaining < 2) {
    return `This assessment expires in less than 2 minutes. Act immediately or request a fresh assessment.`;
  }
  if (minutesRemaining < 60) {
    return `Valid for approximately ${minutesRemaining} minutes. After expiry, you must call assess_strategy_preset again before applying any transition.`;
  }
  const hours = Math.round(minutesRemaining / 60);
  return `Valid for approximately ${hours} hour${hours !== 1 ? 's' : ''}. After expiry, you must call assess_strategy_preset again before applying any transition.`;
}

export function mapOutcomeToResultEntry(
  symbol: string,
  outcome: AssessmentRequestPortOutcome,
  idempotencyKey: string | null,
): AssessmentResultEntry {
  if (outcome.kind === 'cache_hit' || outcome.kind === 'assessment_completed') {
    return {
      success: true,
      symbol,
      canonicalIdentity: outcome.canonicalIdentity,
      assessment: {
        artifactId: outcome.assessmentArtifactId,
        assessedAt: outcome.artifact.assessedAt,
        expiresAt: outcome.artifact.expiresAt,
        marketSummary: outcome.artifact.currentMarketSummary,
        regimeSummary: outcome.artifact.regimeSummary,
        scanHealthSummary: outcome.artifact.scanHealthSummary,
        rankings: outcome.artifact.presetRankings,
        recommendedPreset: outcome.artifact.recommendedPreset,
        allowedPresets: outcome.artifact.allowedPresets,
        freshnessNote: computeFreshnessNote(outcome.artifact.expiresAt),
        confidence: outcome.artifact.confidence,
        urgency: outcome.artifact.urgency,
      },
      transitionReference: {
        assessmentArtifactId: outcome.assessmentArtifactId,
      },
      billing: {
        billed: true,
        requestId: outcome.requestId ?? null,
        idempotencyKey,
        source: outcome.kind === 'cache_hit' ? 'cache_hit' : 'new_run',
      },
    };
  }

  if (outcome.kind === 'provider_failed') {
    return {
      success: false,
      symbol,
      error: outcome.error ?? 'Provider failed',
      errorCode: outcome.errorCode ?? 'assessment.provider_failed',
      canonicalIdentity: outcome.canonicalIdentity,
      billing: {
        billed: false,
        requestId: outcome.requestId ?? null,
        idempotencyKey,
        source: 'failed',
      },
    };
  }

  // Blocked outcomes: request_in_flight, billing_blocked, cooldown_blocked, identity_unresolved
  let error: string;
  let errorCode: string;
  let requestId: string | null = null;
  let canonicalIdentity: AssessmentResultEntry['canonicalIdentity'] = undefined;

  switch (outcome.kind) {
    case 'billing_blocked':
      error = outcome.reason ?? 'Billing blocked';
      errorCode = 'assessment.billing_blocked';
      requestId = outcome.requestId ?? null;
      canonicalIdentity = outcome.canonicalIdentity;
      break;
    case 'cooldown_blocked':
      error = `Assessment on cooldown until ${outcome.nextEligibleAt ?? 'unknown'}`;
      errorCode = 'assessment.cooldown_blocked';
      requestId = outcome.requestId ?? null;
      canonicalIdentity = outcome.canonicalIdentity;
      break;
    case 'identity_unresolved':
      error = outcome.reason ?? 'Identity unresolved';
      errorCode = 'assessment.identity_unresolved';
      requestId = outcome.requestId ?? null;
      break;
    case 'request_in_flight':
      error = outcome.message ?? 'Request in flight';
      errorCode = 'assessment.request_in_flight';
      canonicalIdentity = outcome.canonicalIdentity;
      break;
    default:
      error = 'Assessment request blocked';
      errorCode = 'assessment.blocked';
  }

  return {
    success: false,
    symbol,
    error,
    errorCode,
    canonicalIdentity,
    billing: {
      billed: false,
      requestId,
      idempotencyKey,
      source: 'failed',
    },
  };
}

async function executeAssessStrategyPreset(
  params: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = AssessStrategyPresetParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { success: false, error: 'Invalid parameters', errorCode: 'validation.invalid_params' };
  }
  const { symbols, venueFamily, instrumentKind, idempotencyKey } = parsed.data;

  // ── VenueFamily is required (R11) ──
  if (!venueFamily) {
    return {
      success: false,
      error: 'venueFamily is required for assessment requests. Specify the target venue (e.g. hyperliquid, jupiter).',
      errorCode: 'assessment.venue_family_required',
    };
  }

  // ── Configurable cap ──
  const maxInstrumentsPerRequest = port?.maxInstrumentsPerRequest ?? 3;
  const cap = Math.max(1, maxInstrumentsPerRequest);
  const acceptedSymbols = symbols.slice(0, cap);
  const truncated = symbols.length > cap;

  // ── Resolve styleTier from agent's active config ──
  let styleTier: 'economy' | 'standard' | 'premium' = 'standard';
  if (ctx.agentConfigOps) {
    const config = await ctx.agentConfigOps.getCurrentConfig();
    if (config?.allowedPresets?.styleTier) {
      styleTier = config.allowedPresets.styleTier;
    }
  }

  const resolvedInstrumentKind = (instrumentKind ?? 'orderbook') as 'orderbook' | 'perp' | 'swap' | 'dex';

  // ── Delegate to AssessmentRequestPort if wired ──
  if (port) {
    // Build AssessmentRequestPortParams for each accepted symbol
    const paramsArray: AssessmentRequestPortParams[] = acceptedSymbols.map((symbol) => ({
      agentId: ctx.agentId,
      symbol,
      venueFamily,
      instrumentKind: resolvedInstrumentKind,
      styleTier,
      idempotencyKey,
    }));

    const batchResult = await port.requestBatchAssessment(paramsArray);

    if (!batchResult.ok) {
      const results: AssessmentResultEntry[] = acceptedSymbols.map((symbol) => ({
        success: false,
        symbol,
        error: batchResult.error.message,
        errorCode: batchResult.error.code,
        billing: {
          billed: false,
          requestId: null,
          idempotencyKey: idempotencyKey ?? null,
          source: 'failed',
        },
      }));

      const response: AssessStrategyPresetResponse = {
        success: true,
        data: {
          requestedInstrumentCount: symbols.length,
          assessedInstrumentCount: acceptedSymbols.length,
          maxInstrumentsPerRequest: cap,
          message: truncated
            ? `Requested ${symbols.length} instruments; only the first ${cap} were assessed because the per-request maximum is ${cap}.`
            : undefined,
          results,
        },
      };

      return AssessStrategyPresetResponseSchema.parse(response) as unknown as ToolResult;
    }

    // Zip outcomes with symbols (outcomes are in request order)
    const outcomes = batchResult.data;

    // Defensive guard: verify port returned the expected number of outcomes
    if (outcomes.length !== acceptedSymbols.length) {
      return {
        success: false,
        error: `Port returned ${outcomes.length} outcomes for ${acceptedSymbols.length} requested instruments`,
        errorCode: 'assessment.port_mismatch',
      };
    }

    const results: AssessmentResultEntry[] = acceptedSymbols.map((symbol, idx) =>
      mapOutcomeToResultEntry(symbol, outcomes[idx]!, idempotencyKey ?? null),
    );

    const response: AssessStrategyPresetResponse = {
      success: true,
      data: {
        requestedInstrumentCount: symbols.length,
        assessedInstrumentCount: acceptedSymbols.length,
        maxInstrumentsPerRequest: cap,
        message: truncated
          ? `Requested ${symbols.length} instruments; only the first ${cap} were assessed because the per-request maximum is ${cap}.`
          : undefined,
        results,
      },
    };

    return AssessStrategyPresetResponseSchema.parse(response) as unknown as ToolResult;
  }

  // ── Fallback: port not wired ──
  logger.warn('AssessmentRequestPort not wired — returning unavailable for all instruments');
  const results: AssessmentResultEntry[] = acceptedSymbols.map((symbol) => ({
    success: false,
    symbol,
    error: 'Assessment request port not available. Assessments will be available once the service is deployed.',
    errorCode: 'assessment.service_unavailable',
    billing: {
      billed: false,
      requestId: null,
      idempotencyKey: idempotencyKey ?? null,
      source: 'failed',
    },
  }));

  const response: AssessStrategyPresetResponse = {
    success: true,
    data: {
      requestedInstrumentCount: symbols.length,
      assessedInstrumentCount: acceptedSymbols.length,
      maxInstrumentsPerRequest: cap,
      message: truncated
        ? `Requested ${symbols.length} instruments; only the first ${cap} were assessed because the per-request maximum is ${cap}.`
        : undefined,
      results,
    },
  };

  return AssessStrategyPresetResponseSchema.parse(response) as unknown as ToolResult;
}

export const assessStrategyPresetTool: AgentTool = {
  name: 'assess_strategy_preset',
  description:
    'Request a market assessment that ranks available strategy presets for one or more trading symbols on a venue. ' +
    'Returns for each symbol: ranked presets with scores, pros, and cons; the recommended preset (top-ranked, if confidence/score thresholds are met); ' +
    'allowed presets — the subset of ranked presets that are eligible for change_strategy_preset; ' +
    'an assessment artifact ID, expiry time, and a freshnessNote indicating how long the artifact remains valid. ' +
    'Accepts up to the configured maximum instruments per request (default 3). ' +
    '⚠️ Each assessed instrument incurs a billing charge. Use idempotencyKey to avoid duplicate charges on retry. ' +
    'Requires venueFamily (e.g. hyperliquid, jupiter). ' +
    'After receiving results, review the rankings and allowedPresets, then use change_strategy_preset to apply a switch. ' +
    'If the artifact expires, request a fresh assessment — do not reuse an expired artifact ID.',
  parametersSchema: AssessStrategyPresetParamsSchema,
  parameters: convertZodToJsonSchema(AssessStrategyPresetParamsSchema),
  category: 'read-database',
  execute: executeAssessStrategyPreset,
};

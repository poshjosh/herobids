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

function mapOutcomeToResultEntry(
  symbol: string,
  outcome: AssessmentRequestPortOutcome,
  idempotencyKey: string | null,
): AssessmentResultEntry {
  if (outcome.kind === 'cache_hit' || outcome.kind === 'assessment_completed') {
    return {
      success: true,
      symbol,
      transitionReference: {
        assessmentArtifactId: outcome.assessmentArtifactId!,
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

  switch (outcome.kind) {
    case 'billing_blocked':
      error = outcome.reason ?? 'Billing blocked';
      errorCode = 'assessment.billing_blocked';
      requestId = outcome.requestId ?? null;
      break;
    case 'cooldown_blocked':
      error = `Assessment on cooldown until ${outcome.nextEligibleAt ?? 'unknown'}`;
      errorCode = 'assessment.cooldown_blocked';
      requestId = outcome.requestId ?? null;
      break;
    case 'identity_unresolved':
      error = outcome.reason ?? 'Identity unresolved';
      errorCode = 'assessment.identity_unresolved';
      requestId = outcome.requestId ?? null;
      break;
    case 'request_in_flight':
      error = outcome.message ?? 'Request in flight';
      errorCode = 'assessment.request_in_flight';
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

  const resolvedInstrumentKind = (instrumentKind ?? 'orderbook') as 'orderbook' | 'perp';

  // ── Delegate to AssessmentRequestPort if wired ──
  if (port) {
    // Build AssessmentRequestPortParams for each accepted symbol
    const paramsArray: AssessmentRequestPortParams[] = acceptedSymbols.map((symbol) => ({
      agentId: ctx.agentId,
      symbol,
      identity: {
        instrumentKind: resolvedInstrumentKind,
        venueFamily,
        styleTier,
        symbol,
      },
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
    'Request a billable market preset assessment for one or more trading symbols on a specific venue. ' +
    'Returns ranked presets, confidence scores, market summary, and the exact transition reference needed for change_strategy_preset. ' +
    'Accepts up to the configured maximum instruments per request (default 3). ' +
    '⚠️ Each assessed instrument incurs a billing charge at the assessment.request rate (cache hits are also billed). ' +
    'Use the idempotencyKey parameter to avoid duplicate charges on retry. ' +
    'A provider_failed outcome releases the reservation without charge, but a retry creates a new billable attempt. ' +
    'Requires venueFamily (e.g. hyperliquid, jupiter) — venue inference is not supported.',
  parametersSchema: AssessStrategyPresetParamsSchema,
  parameters: convertZodToJsonSchema(AssessStrategyPresetParamsSchema),
  category: 'read-database',
  execute: executeAssessStrategyPreset,
};

import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import {
  AssessStrategyPresetParamsSchema,
  AssessStrategyPresetResponseSchema,
  resolveAssessmentIdentity,
  isArtifactFresh,
  type MarketAssessmentIdentity,
  type AssessmentResultEntry,
  type AssessStrategyPresetResponse,
} from '@herobids/domain';
import { marketAssessmentArtifacts } from '@herobids/db';
import { and, eq, desc } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@herobids/db/schema';
import { convertZodToJsonSchema } from './registry.js';
import { createLogger } from '../logger.js';

const logger = createLogger('tool:assess-strategy-preset');

type Db = PostgresJsDatabase<typeof schema>;

/**
 * Build a where clause for the canonical identity columns on the artifacts table.
 * Uses the per-symbol identity model: orderbook/perp keyed by symbol,
 * swap/dex keyed by network + address.
 */
function identityWhereClause(identity: MarketAssessmentIdentity, table: typeof marketAssessmentArtifacts) {
  if (identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex') {
    const { network, address } = identity as Extract<MarketAssessmentIdentity, { instrumentKind: 'swap' | 'dex' }>;
    return and(
      eq(table.instrumentKind, identity.instrumentKind),
      eq(table.venueFamily, identity.venueFamily),
      eq(table.styleTier, identity.styleTier),
      eq(table.network, network),
      eq(table.address, address),
    );
  }
  // orderbook | perp
  const { symbol } = identity as Extract<MarketAssessmentIdentity, { instrumentKind: 'orderbook' | 'perp' }>;
  return and(
    eq(table.instrumentKind, identity.instrumentKind),
    eq(table.venueFamily, identity.venueFamily),
    eq(table.styleTier, identity.styleTier),
    eq(table.symbol, symbol),
  );
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

  const db = ctx.db as Db | undefined;
  if (!db) {
    return { success: false, error: 'Database not available', errorCode: 'db.unavailable' };
  }

  // ── Configurable cap ──
  // TODO: Read maxInstrumentsPerRequest from operator config (platformAssessor.maxInstrumentsPerRequest).
  // Currently hardcoded to the plan default (3). ToolContext does not yet expose operator-level config.
  const maxInstrumentsPerRequest = 3;
  const cap = Math.max(1, maxInstrumentsPerRequest);
  const acceptedSymbols = symbols.slice(0, cap);
  const truncated = symbols.length > cap;

  // ── Resolve styleTier from agent's active config ──
  let styleTier: 'economy' | 'standard' | 'premium' = 'standard';
  if (ctx.agentConfigOps) {
    const config = await ctx.agentConfigOps.getCurrentConfig();
    // TODO: resolve styleTier from agent's preset tier when the unified config API exposes it cleanly
    if (config?.allowedPresets?.styleTier) {
      styleTier = config.allowedPresets.styleTier;
    }
  }

  const results: AssessmentResultEntry[] = [];
  const now = new Date();

  for (const symbol of acceptedSymbols) {
    // 1. Resolve canonical identity — hoisted before try/catch so it is
    //    available in error entries when a later DB query throws.
    const identityResult = resolveAssessmentIdentity({
      instrumentKind,
      venueFamily,
      styleTier,
      symbol,
      // TODO: wire knownSymbols from venue instrument cache for orderbook/perp validation
      // TODO: wire tokenResolutions from venue token registry for swap/dex resolution
    });

    if (!identityResult.ok) {
      results.push({
        success: false,
        symbol,
        error: identityResult.error.message,
        errorCode: identityResult.error.code,
        billing: {
          billed: false,
          requestId: null,
          idempotencyKey: idempotencyKey ?? null,
          source: 'failed',
        },
      });
      continue;
    }

    const canonicalIdentity = identityResult.data;

    try {
      // 2. Look up the latest active artifact for this canonical identity
      const [latest] = await db
        .select()
        .from(marketAssessmentArtifacts)
        .where(and(
          identityWhereClause(canonicalIdentity, marketAssessmentArtifacts),
          eq(marketAssessmentArtifacts.status, 'active'),
        ))
        .orderBy(desc(marketAssessmentArtifacts.assessedAt))
        .limit(1);

      if (latest) {
        const artifact = {
          id: latest.id,
          assessedAt: latest.assessedAt.toISOString(),
          expiresAt: latest.expiresAt.toISOString(),
          styleTier: latest.styleTier,
          allowedPresets: latest.allowedPresets as string[],
          currentMarketSummary: latest.currentMarketSummary,
          regimeSummary: latest.regimeSummary,
          scanHealthSummary: latest.scanHealthSummary,
          presetRankings: latest.presetRankings,
          recommendedPreset: latest.recommendedPreset,
          confidence: Number(latest.confidence),
          urgency: latest.urgency as 'low' | 'medium' | 'high',
          reasoningSummary: latest.reasoningSummary,
        };

        const fresh = isArtifactFresh(
          { status: latest.status, expiresAt: artifact.expiresAt },
          now,
        );

        if (fresh) {
          // Cache hit — billable
          const rankings = artifact.presetRankings as Array<{
            presetKey: string;
            presetBehaviorVersion: string;
            rank: number;
            score: number;
            scoreBand: string;
            pros: string[];
            cons: string[];
            fitNotes: string | null;
          }>;

          results.push({
            success: true,
            symbol,
            canonicalIdentity,
            assessment: {
              artifactId: latest.id,
              assessedAt: artifact.assessedAt,
              expiresAt: artifact.expiresAt,
              marketSummary: artifact.currentMarketSummary,
              regimeSummary: artifact.regimeSummary,
              scanHealthSummary: artifact.scanHealthSummary,
              rankings,
              recommendedPreset: artifact.recommendedPreset,
              confidence: artifact.confidence,
              urgency: artifact.urgency,
            },
            transitionReference: {
              assessmentArtifactId: latest.id,
            },
            billing: {
              billed: true,
              requestId: null,
              idempotencyKey: idempotencyKey ?? null,
              source: 'cache_hit',
            },
          });
          continue;
        }

        // Artifact exists but expired — fall through to new-run stub
      }

      // 3. No fresh artifact — run a new assessment (stub for now)
      // TODO: route through AssessmentRequestService when implemented
      // For now, this is a stub that returns a no-artifact-available result.
      // When the assessment request service is wired, this will:
      //   - submit an assessment request
      //   - wait for the result
      //   - persist the artifact
      //   - return the fresh artifact data
      results.push({
        success: false,
        symbol,
        canonicalIdentity,
        error: 'No fresh assessment artifact available for this symbol. A new assessment will be generated on the next scanner run.',
        errorCode: 'assessment.no_fresh_artifact',
        billing: {
          billed: false,
          requestId: null,
          idempotencyKey: idempotencyKey ?? null,
          source: 'failed',
        },
      });
    } catch (err) {
      logger.error({ err, symbol }, 'Failed to assess strategy preset for symbol');
      results.push({
        success: false,
        symbol,
        canonicalIdentity,
        error: err instanceof Error ? err.message : 'Unexpected error',
        errorCode: 'assessment.internal_error',
        billing: {
          billed: false,
          requestId: null,
          idempotencyKey: idempotencyKey ?? null,
          source: 'failed',
        },
      });
    }
  }

  const message = truncated
    ? `Requested ${symbols.length} instruments; only the first ${cap} were assessed because the per-request maximum is ${cap}.`
    : undefined;

  const response: AssessStrategyPresetResponse = {
    success: true,
    data: {
      requestedInstrumentCount: symbols.length,
      assessedInstrumentCount: acceptedSymbols.length,
      maxInstrumentsPerRequest: cap,
      message,
      results,
    },
  };

  // AssessStrategyPresetResponse has the same shape as ToolResult
  // ({success, data, error, errorCode}) — return it directly to avoid double-wrapping.
  return AssessStrategyPresetResponseSchema.parse(response) as unknown as ToolResult;
}

export const assessStrategyPresetTool: AgentTool = {
  name: 'assess_strategy_preset',
  description:
    'Request a billable market preset assessment for one or more trading symbols on a specific venue. ' +
    'Returns ranked presets, confidence scores, market summary, and the exact transition reference needed for change_strategy_preset. ' +
    'Accepts up to the configured maximum instruments per request (default 3). ' +
    'Each assessed instrument incurs a billing charge. Use idempotencyKey to avoid duplicate charges on retry.',
  parametersSchema: AssessStrategyPresetParamsSchema,
  parameters: convertZodToJsonSchema(AssessStrategyPresetParamsSchema),
  category: 'read-database',
  execute: executeAssessStrategyPreset,
};

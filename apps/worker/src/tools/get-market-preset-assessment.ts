import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import {
  GetMarketPresetAssessmentParamsSchema,
  resolveAssessmentIdentity,
  isArtifactFresh,
  type MarketAssessmentIdentity,
} from '@herobids/domain';
import { marketAssessmentArtifacts } from '@herobids/db';
import { and, eq, desc } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@herobids/db/schema';
import { convertZodToJsonSchema } from './registry.js';
import { createLogger } from '../logger.js';

const logger = createLogger('tool:get-market-preset-assessment');

type Db = PostgresJsDatabase<typeof schema>;

/**
 * Build a where clause for the canonical identity columns on the artifacts table.
 * Uses the new per-symbol identity model: orderbook/perp keyed by symbol,
 * swap/dex keyed by network + address.
 */
function identityWhereClause(identity: MarketAssessmentIdentity, table: typeof marketAssessmentArtifacts) {
  if (identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex') {
    return and(
      eq(table.instrumentKind, identity.instrumentKind),
      eq(table.venueFamily, identity.venueFamily),
      eq(table.styleTier, identity.styleTier),
      eq(table.network, identity.network),
      eq(table.address, identity.address),
    );
  }
  // orderbook | perp
  return and(
    eq(table.instrumentKind, identity.instrumentKind),
    eq(table.venueFamily, identity.venueFamily),
    eq(table.styleTier, identity.styleTier),
    eq(table.symbol, identity.symbol),
  );
}

async function executeGetMarketPresetAssessment(
  params: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = GetMarketPresetAssessmentParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { success: false, error: 'Invalid parameters', errorCode: 'validation.invalid_params' };
  }
  const { symbol, venueFamily, instrumentKind, idempotencyKey } = parsed.data;

  const db = ctx.db as Db | undefined;
  if (!db) {
    return { success: false, error: 'Database not available', errorCode: 'db.unavailable' };
  }

  try {
    // Require venue family — the agent must scope its assessment to a venue.
    // TODO: resolve from agent config (agentConfigOps.getCurrentConfig()) or binding when ToolContext exposes it.
    if (!venueFamily) {
      return { success: false, error: 'venueFamily is required. Specify the venue to assess (e.g. "hyperliquid", "bybit", "jupiter").', errorCode: 'validation.missing_venue_family' };
    }
    const resolvedInstrumentKind = instrumentKind ?? 'orderbook';

    // Resolve canonical identity — this is the single normalization boundary
    const identityResult = resolveAssessmentIdentity({
      instrumentKind: resolvedInstrumentKind,
      venueFamily,
      styleTier: 'standard',
      // TODO: resolve styleTier from agent's active preset tier when ToolContext exposes it
      symbol,
      // TODO: wire knownSymbols from venue instrument cache for orderbook/perp validation
      // TODO: wire tokenResolutions from venue token registry for swap/dex resolution
    });

    if (!identityResult.ok) {
      return {
        success: false,
        error: identityResult.error.message,
        errorCode: identityResult.error.code,
      };
    }

    const identity = identityResult.data;

    // Look up the latest active artifact for this canonical identity
    const [latest] = await db
      .select()
      .from(marketAssessmentArtifacts)
      .where(and(
        identityWhereClause(identity, marketAssessmentArtifacts),
        eq(marketAssessmentArtifacts.status, 'active'),
      ))
      .orderBy(desc(marketAssessmentArtifacts.assessedAt))
      .limit(1);

    const now = new Date();

    if (!latest) {
      return {
        success: true,
        data: {
          available: false,
          canonicalIdentity: identity,
          message: 'No active market assessment artifact available for this symbol. Request a new assessment to generate one.',
          assessedAt: null,
          expiresAt: null,
        },
      };
    }

    // Build a domain-compatible artifact shape from the DB row
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

    return {
      success: true,
      data: {
        available: true,
        fresh,
        canonicalIdentity: identity,
        assessmentArtifactId: latest.id,
        artifact,
        idempotencyKey: idempotencyKey ?? null,
        // TODO: billing outcome — wire once AssessmentRequestService is implemented (§8)
        billingOutcome: 'not_implemented' as const,
        requestId: null,
      },
    };
  } catch (err) {
    logger.error({ err }, 'Failed to get market preset assessment');
    return { success: false, error: 'Failed to retrieve market assessment', errorCode: 'assessment.read_failed' };
  }
}



export const getMarketPresetAssessmentTool: AgentTool = {
  name: 'get_market_preset_assessment',
  description:
    'Request a market preset assessment for a specific trading symbol. ' +
    'Resolves the canonical per-symbol identity, looks up the latest fresh assessment artifact, ' +
    'and returns ranked presets, confidence, and market summary. ' +
    'IMPORTANT: This tool may incur a billing charge — every successful assessment request ' +
    '(including cache hits) is billable. Use the returned idempotencyKey to avoid duplicate charges on retry.',
  parametersSchema: GetMarketPresetAssessmentParamsSchema,
  parameters: convertZodToJsonSchema(GetMarketPresetAssessmentParamsSchema),
  category: 'read-database',
  execute: executeGetMarketPresetAssessment,
};

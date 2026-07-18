import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import {
  RecommendPresetTransitionParamsSchema,
  isArtifactFresh,
  type MarketAssessmentIdentity,
} from '@herobids/domain';
import { marketAssessmentArtifacts } from '@herobids/db';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@herobids/db/schema';
import { convertZodToJsonSchema } from './registry.js';
import { createLogger } from '../logger.js';

const logger = createLogger('tool:recommend-preset-transition');

type Db = PostgresJsDatabase<typeof schema>;

async function executeRecommendPresetTransition(
  params: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = RecommendPresetTransitionParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { success: false, error: 'Invalid parameters', errorCode: 'validation.invalid_params' };
  }
  const { assessmentArtifactId, symbol } = parsed.data;

  const db = ctx.db as Db | undefined;
  if (!db) {
    return { success: false, error: 'Database not available', errorCode: 'db.unavailable' };
  }

  try {
    let artifactRow: typeof marketAssessmentArtifacts.$inferSelect | undefined;
    let resolvedIdentity: MarketAssessmentIdentity | undefined;

    // Path A: exact artifact ID (preferred — handoff from get_market_preset_assessment)
    if (assessmentArtifactId) {
      const [row] = await db
        .select()
        .from(marketAssessmentArtifacts)
        .where(eq(marketAssessmentArtifacts.id, assessmentArtifactId))
        .limit(1);
      artifactRow = row;

      if (!artifactRow) {
        return {
          success: false,
          error: `Assessment artifact "${assessmentArtifactId}" not found.`,
          errorCode: 'assessment.artifact_not_found',
        };
      }

      // Reconstruct identity from the artifact row
      if (artifactRow.instrumentKind === 'orderbook' || artifactRow.instrumentKind === 'perp') {
        resolvedIdentity = {
          instrumentKind: artifactRow.instrumentKind as 'orderbook' | 'perp',
          venueFamily: artifactRow.venueFamily,
          styleTier: artifactRow.styleTier as 'economy' | 'standard' | 'premium',
          symbol: artifactRow.symbol!,
        };
      } else {
        resolvedIdentity = {
          instrumentKind: artifactRow.instrumentKind as 'swap' | 'dex',
          venueFamily: artifactRow.venueFamily,
          styleTier: artifactRow.styleTier as 'economy' | 'standard' | 'premium',
          network: artifactRow.network!,
          address: artifactRow.address!,
        };
      }
    } else if (symbol) {
      // Path B: symbol-first resolution — not yet supported without venue context.
      // TODO: resolve venueFamily and instrumentKind from agent config when ToolContext exposes it.
      return {
        success: false,
        error: 'Symbol-first resolution without assessmentArtifactId requires venue context. Provide assessmentArtifactId from get_market_preset_assessment, or specify venueFamily and instrumentKind.',
        errorCode: 'validation.missing_venue_context',
      };
    } else {
      return { success: false, error: 'Either assessmentArtifactId or symbol must be provided.', errorCode: 'validation.invalid_params' };
    }

    // Validate freshness — must NOT start a new billable assessment
    const now = new Date();
    const artifact = {
      id: artifactRow.id,
      assessedAt: artifactRow.assessedAt.toISOString(),
      expiresAt: artifactRow.expiresAt.toISOString(),
      styleTier: artifactRow.styleTier,
      allowedPresets: artifactRow.allowedPresets as string[],
      currentMarketSummary: artifactRow.currentMarketSummary,
      regimeSummary: artifactRow.regimeSummary,
      scanHealthSummary: artifactRow.scanHealthSummary,
      presetRankings: artifactRow.presetRankings as Array<{
        presetKey: string;
        presetBehaviorVersion: string;
        rank: number;
        score: number;
        scoreBand: string;
        pros: string[];
        cons: string[];
        fitNotes: string | null;
      }>,
      recommendedPreset: artifactRow.recommendedPreset,
      confidence: Number(artifactRow.confidence),
      urgency: artifactRow.urgency as 'low' | 'medium' | 'high',
      reasoningSummary: artifactRow.reasoningSummary,
    };

    if (!isArtifactFresh(
      { status: artifactRow.status, expiresAt: artifact.expiresAt },
      now,
    )) {
      return {
        success: false,
        error: 'The assessment artifact has expired. Request a fresh assessment via get_market_preset_assessment before recommending a transition.',
        errorCode: 'assessment.artifact_expired',
      };
    }

    // Build recommendation from rankings
    const rankings = artifact.presetRankings as Array<{
      presetKey: string;
      rank: number;
      score: number;
      pros: string[];
      cons: string[];
      fitNotes: string | null;
    }>;
    const topRanked = [...rankings].sort((a, b) => a.rank - b.rank)[0];

    return {
      success: true,
      data: {
        recommendation: {
          recommendedPreset: topRanked?.presetKey ?? null,
          score: topRanked?.score ?? null,
          confidence: artifact.confidence,
          urgency: artifact.urgency,
          marketSummary: artifact.currentMarketSummary,
          pros: topRanked?.pros ?? [],
          cons: topRanked?.cons ?? [],
          note: 'This is an advisory platform-level assessment recommendation — it is NOT personalized to your open positions, recent performance, or risk state. Review your portfolio and risk limits before applying.',
        },
        assessmentArtifactId: artifact.id,
        canonicalIdentity: resolvedIdentity,
        assessedAt: artifact.assessedAt,
        expiresAt: artifact.expiresAt,
        rankings,
      },
    };
  } catch (err) {
    logger.error({ err }, 'Failed to recommend preset transition');
    return { success: false, error: 'Failed to generate transition recommendation', errorCode: 'transition.recommend_failed' };
  }
}

export const recommendPresetTransitionTool: AgentTool = {
  name: 'recommend_preset_transition',
  description:
    'Get the top-ranked preset recommendation from a specific market assessment artifact. ' +
    'Accepts an exact assessmentArtifactId (from get_market_preset_assessment) or a symbol to resolve the latest fresh artifact. ' +
    'This tool does NOT start a new billable assessment — it only reads an existing artifact. ' +
    'Review your open positions and performance before applying any recommendation.',
  parametersSchema: RecommendPresetTransitionParamsSchema,
  parameters: convertZodToJsonSchema(RecommendPresetTransitionParamsSchema),
  category: 'read-database',
  execute: executeRecommendPresetTransition,
};

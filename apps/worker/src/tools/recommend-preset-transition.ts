import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { RecommendPresetTransitionParamsSchema } from '@herobids/domain';
import { marketAssessmentArtifacts } from '@herobids/db';
import { eq, desc } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@herobids/db/schema';
import { convertZodToJsonSchema } from './registry.js';
import { createLogger } from '../logger.js';

const logger = createLogger('tool:recommend-preset-transition');

type Db = PostgresJsDatabase<typeof schema>;

async function executeRecommendPresetTransition(
  _params: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const db = ctx.db as Db | undefined;
  if (!db) {
    return { success: false, error: 'Database not available', errorCode: 'db.unavailable' };
  }

  try {
    const [latest] = await db
      .select()
      .from(marketAssessmentArtifacts)
      .where(eq(marketAssessmentArtifacts.status, 'active'))
      .orderBy(desc(marketAssessmentArtifacts.assessedAt))
      .limit(1);

    if (!latest) {
      return { success: true, data: { recommendation: null, reason: 'No active assessment artifact available.' } };
    }

    const rankings = latest.presetRankings as Array<{
      presetKey: string;
      rank: number;
      score: number;
      pros: string[];
      cons: string[];
      fitNotes: string | null;
    }>;

    const topRanked = rankings.sort((a, b) => a.rank - b.rank)[0];

    return {
      success: true,
      data: {
        recommendation: {
          recommendedPreset: topRanked?.presetKey ?? null,
          score: topRanked?.score ?? null,
          confidence: latest.confidence,
          urgency: latest.urgency,
          marketSummary: latest.currentMarketSummary,
          pros: topRanked?.pros ?? [],
          cons: topRanked?.cons ?? [],
          note: 'This is a shared platform-level assessment recommendation — it is NOT personalized to your open positions, recent performance, or risk state. Review your portfolio and risk limits before applying.',
        },
        assessmentRef: latest.id,
        assessedAt: latest.assessedAt,
      },
    };
  } catch (err) {
    logger.error({ err }, 'Failed to recommend preset transition');
    return { success: false, error: 'Failed to generate transition recommendation', errorCode: 'transition.recommend_failed' };
  }
}

export const recommendPresetTransitionTool: AgentTool = {
  name: 'recommend_preset_transition',
  description: 'Get the top-ranked preset recommendation from the latest shared market assessment artifact. Review your open positions and performance before applying.',
  parametersSchema: RecommendPresetTransitionParamsSchema,
  parameters: convertZodToJsonSchema(RecommendPresetTransitionParamsSchema),
  category: 'read-database',
  execute: executeRecommendPresetTransition,
};

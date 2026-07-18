import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { GetMarketPresetAssessmentParamsSchema } from '@herobids/domain';
import { marketAssessmentArtifacts } from '@herobids/db';
import { eq, desc } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@herobids/db/schema';
import { convertZodToJsonSchema } from './registry.js';
import { createLogger } from '../logger.js';

const logger = createLogger('tool:get-market-preset-assessment');

type Db = PostgresJsDatabase<typeof schema>;

async function executeGetMarketPresetAssessment(
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
      return { success: true, data: { available: false, message: 'No active market assessment artifact available.' } };
    }

    return {
      success: true,
      data: {
        available: true,
        artifact: {
          id: latest.id,
          assessedAt: latest.assessedAt,
          expiresAt: latest.expiresAt,
          styleTier: latest.styleTier,
          allowedPresets: latest.allowedPresets,
          currentMarketSummary: latest.currentMarketSummary,
          regimeSummary: latest.regimeSummary,
          scanHealthSummary: latest.scanHealthSummary,
          presetRankings: latest.presetRankings,
          recommendedPreset: latest.recommendedPreset,
          confidence: latest.confidence,
          urgency: latest.urgency,
          reasoningSummary: latest.reasoningSummary,
        },
      },
    };
  } catch (err) {
    logger.error({ err }, 'Failed to get market preset assessment');
    return { success: false, error: 'Failed to retrieve market assessment', errorCode: 'assessment.read_failed' };
  }
}

export const getMarketPresetAssessmentTool: AgentTool = {
  name: 'get_market_preset_assessment',
  description: 'Read the latest shared market preset assessment artifact for your trading segment. Returns ranked presets, confidence, and market summary.',
  parametersSchema: GetMarketPresetAssessmentParamsSchema,
  parameters: convertZodToJsonSchema(GetMarketPresetAssessmentParamsSchema),
  category: 'read-database',
  execute: executeGetMarketPresetAssessment,
};

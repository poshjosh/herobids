import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const StrategySchemasQuerySchema = z.object({
  type: z.string().optional(),
});

/**
 * Per-strategy parameter schemas with presets (safe defaults).
 * These are the params objects that go inside create_bot.config.strategy.params
 * or adjust_bot_config.config.strategy.params.
 *
 * NOTE: The raw JSON Schema forms of these schemas also appear in
 * packages/domain/src/tool-schemas.ts under 'create_bot.config.strategy.params'.
 * That registry is the canonical source for the agent-facing get_schema tool.
 * This route adds presets (safe default values) and per-strategy descriptions
 * that the domain registry does not include. When adding a new strategy type,
 * update both locations.
 */
const STRATEGY_PARAM_SCHEMAS: Record<string, {
  schema: Record<string, unknown>;
  preset: Record<string, unknown>;
  description: string;
}> = {
  momentum: {
    schema: {
      type: 'object',
      properties: {
        lookbackPeriod: { type: 'integer', minimum: 1, maximum: 200, default: 14, description: 'Number of candles for indicator calculation' },
        signalThreshold: { type: 'number', minimum: 0, maximum: 1, default: 0.6, description: 'Minimum signal strength to act (0-1)' },
        rsiPeriod: { type: 'integer', minimum: 2, maximum: 100, default: 14, description: 'RSI calculation period' },
        rsiOversold: { type: 'integer', minimum: 0, maximum: 100, default: 30, description: 'RSI oversold threshold' },
        rsiOverbought: { type: 'integer', minimum: 0, maximum: 100, default: 70, description: 'RSI overbought threshold' },
        macdFast: { type: 'integer', minimum: 2, maximum: 100, default: 12, description: 'MACD fast EMA period' },
        macdSlow: { type: 'integer', minimum: 2, maximum: 100, default: 26, description: 'MACD slow EMA period' },
        macdSignal: { type: 'integer', minimum: 2, maximum: 100, default: 9, description: 'MACD signal EMA period' },
      },
      additionalProperties: false,
    },
    preset: {
      lookbackPeriod: 14,
      signalThreshold: 0.6,
    },
    description: 'Momentum strategy — follows directional trends using RSI, MACD, and price action. Higher signalThreshold means fewer but higher-conviction trades.',
  },
  range: {
    schema: {
      type: 'object',
      properties: {
        lookbackPeriod: { type: 'integer', minimum: 1, maximum: 200, default: 20, description: 'Number of candles for range detection' },
        signalThreshold: { type: 'number', minimum: 0, maximum: 1, default: 0.5, description: 'Minimum signal strength to act (0-1)' },
        supportLookback: { type: 'integer', minimum: 5, maximum: 200, default: 20, description: 'Candles for support/resistance detection' },
        breakoutConfirmBars: { type: 'integer', minimum: 1, maximum: 10, default: 2, description: 'Bars to confirm breakout' },
      },
      additionalProperties: false,
    },
    preset: {
      lookbackPeriod: 20,
      signalThreshold: 0.5,
    },
    description: 'Range strategy — trades support/resistance bounces and breakouts. Best in sideways markets.',
  },
  contrarian: {
    schema: {
      type: 'object',
      properties: {
        lookbackPeriod: { type: 'integer', minimum: 1, maximum: 200, default: 14, description: 'Number of candles for indicator calculation' },
        signalThreshold: { type: 'number', minimum: 0, maximum: 1, default: 0.7, description: 'Minimum signal strength to act (0-1)' },
        rsiExtremeOversold: { type: 'integer', minimum: 0, maximum: 100, default: 20, description: 'Extreme RSI oversold for contrarian buy' },
        rsiExtremeOverbought: { type: 'integer', minimum: 0, maximum: 100, default: 80, description: 'Extreme RSI overbought for contrarian sell' },
      },
      additionalProperties: false,
    },
    preset: {
      lookbackPeriod: 14,
      signalThreshold: 0.7,
    },
    description: 'Contrarian strategy — trades against extremes. Buys at extreme fear (low RSI), sells at extreme greed (high RSI).',
  },
  swing: {
    schema: {
      type: 'object',
      properties: {
        lookbackPeriod: { type: 'integer', minimum: 1, maximum: 200, default: 10, description: 'Number of candles for swing detection' },
        signalThreshold: { type: 'number', minimum: 0, maximum: 1, default: 0.55, description: 'Minimum signal strength to act (0-1)' },
        swingHighLowBars: { type: 'integer', minimum: 2, maximum: 20, default: 5, description: 'Bars to confirm swing high/low' },
        minSwingPct: { type: 'number', minimum: 0, maximum: 100, default: 1, description: 'Minimum swing size as % of price' },
      },
      additionalProperties: false,
    },
    preset: {
      lookbackPeriod: 10,
      signalThreshold: 0.55,
    },
    description: 'Swing strategy — captures short-to-medium term price swings. Identifies swing highs/lows for entry/exit.',
  },
  scalper: {
    schema: {
      type: 'object',
      properties: {
        lookbackPeriod: { type: 'integer', minimum: 1, maximum: 200, default: 5, description: 'Number of candles for scalping signals' },
        signalThreshold: { type: 'number', minimum: 0, maximum: 1, default: 0.65, description: 'Minimum signal strength to act (0-1)' },
        targetBps: { type: 'integer', minimum: 1, maximum: 1000, default: 20, description: 'Profit target in basis points' },
        stopBps: { type: 'integer', minimum: 1, maximum: 1000, default: 10, description: 'Stop loss in basis points' },
        maxHoldBars: { type: 'integer', minimum: 1, maximum: 100, default: 5, description: 'Maximum hold duration in bars' },
      },
      additionalProperties: false,
    },
    preset: {
      lookbackPeriod: 5,
      signalThreshold: 0.65,
    },
    description: 'Scalper strategy — very short-term trades targeting small price movements. High frequency, tight stops.',
  },
  dca: {
    schema: {
      type: 'object',
      properties: {
        intervalMs: { type: 'integer', minimum: 60000, default: 3600000, description: 'Time between DCA buys in milliseconds (default: 1 hour)' },
        amountPerBuy: { type: 'string', default: '100', description: 'Fixed amount per DCA buy as decimal string (e.g. "100" = $100 USD equivalent)' },
        maxTotalAllocation: { type: 'string', description: 'Maximum total allocation as decimal string. Stops DCA when reached.' },
      },
      additionalProperties: false,
    },
    preset: {
      intervalMs: 3600000,
      amountPerBuy: '100',
    },
    description: 'DCA (Dollar-Cost Averaging) strategy — buys at fixed intervals regardless of price. No signal required. Good for long-term accumulation.',
  },
};

/**
 * GET /api/v1/strategy-schemas
 * GET /api/v1/strategy-schemas?type=momentum
 *
 * Returns per-strategy parameter schemas and safe default presets.
 * Use these to populate create_bot.config.strategy.params when
 * creating or adjusting a bot.
 */
export async function strategySchemaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/strategy-schemas', async (request, reply) => {
    const query = StrategySchemasQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        ok: false,
        error: 'invalid_query',
        details: query.error.issues,
      });
    }

    const { type } = query.data;

    if (type) {
      const strategySchema = STRATEGY_PARAM_SCHEMAS[type.toLowerCase()];
      if (!strategySchema) {
        return reply.status(404).send({
          ok: false,
          error: 'strategy_not_found',
          message: `No schema found for strategy type "${type}"`,
          availableTypes: Object.keys(STRATEGY_PARAM_SCHEMAS),
        });
      }

      return reply.send({
        ok: true,
        type,
        params: {
          schema: strategySchema.schema,
          preset: strategySchema.preset,
          description: strategySchema.description,
        },
      });
    }

    // List all strategy schemas with their presets
    const schemas = Object.entries(STRATEGY_PARAM_SCHEMAS).map(([strategyType, entry]) => ({
      type: strategyType,
      description: entry.description,
      preset: entry.preset,
    }));

    return reply.send({
      ok: true,
      strategies: schemas,
      guidance: 'Use get_schema("create_bot.config.strategy") for the full StrategySchema. Then use strategy-schemas?type=<type> to get the params schema and preset for that specific strategy type.',
    });
  });
}

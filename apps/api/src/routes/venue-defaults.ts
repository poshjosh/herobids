import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const VenueDefaultsQuerySchema = z.object({
  venue: z.string().min(1).optional(),
});

export interface VenueDefaultsConfig {
  /** Global default slippage tolerance in bps, from operator execution.defaultSlippageBps */
  defaultSlippageBps: number;
}

/**
 * Per-venue fee/order-type constants. These reflect protocol-level characteristics
 * (determined by the venue, not the operator). slippageBps here is a sensible
 * starting point for each venue's typical liquidity — operators control the
 * global default via execution.defaultSlippageBps in operator config.
 *
 * NOTE: feeBps values are indicative. Actual fees vary by volume tier and
 * market conditions. Hyperliquid taker fees range from 2.5 to 0.1 bps based on
 * trading volume. Jupiter has no protocol fees but DEX routing may carry pool
 * fees. These constants should be treated as reasonable defaults, not guarantees.
 */
const VENUE_CONSTANTS: Record<string, {
  feeBps: number;
  recommendedOrderType: string;
  minOrderSizeUsd: number;
  description: string;
}> = {
  hyperliquid: {
    feeBps: 2.5,
    recommendedOrderType: 'limit',
    minOrderSizeUsd: 10,
    description: 'Hyperliquid perpetuals — low slippage, maker/taker fees apply',
  },
  jupiter: {
    feeBps: 0,
    recommendedOrderType: 'swap',
    minOrderSizeUsd: 1,
    description: 'Jupiter DEX aggregator on Solana — variable slippage, no protocol fees',
  },
};

// Venue-specific slippage recommendations (bps). Operators should tune the
// global default via execution.defaultSlippageBps; these are per-venue hints
// based on typical liquidity profiles.
const VENUE_SLIPPAGE_HINTS: Record<string, number> = {
  hyperliquid: 10,
  jupiter: 50,
};

/**
 * GET /api/v1/venue-defaults
 * GET /api/v1/venue-defaults?venue=hyperliquid
 *
 * Returns venue-specific default values for slippage, fees, and
 * recommended order types. slippageBps comes from operator config
 * (execution.defaultSlippageBps) for the global default; per-venue hints
 * reflect typical liquidity profiles for that venue.
 */
export async function venueDefaultsRoutes(app: FastifyInstance, config: VenueDefaultsConfig): Promise<void> {
  const globalDefault = {
    slippageBps: config.defaultSlippageBps,
    feeBps: 10,
    recommendedOrderType: 'limit',
    minOrderSizeUsd: 10,
    description: 'Global defaults — tune slippageBps via operator config (execution.defaultSlippageBps)',
  };

  app.get('/api/v1/venue-defaults', async (request, reply) => {
    const query = VenueDefaultsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        ok: false,
        error: 'invalid_query',
        details: query.error.issues,
      });
    }

    const { venue } = query.data;

    if (venue) {
      const constants = VENUE_CONSTANTS[venue.toLowerCase()];
      if (!constants) {
        return reply.status(404).send({
          ok: false,
          error: 'venue_not_found',
          message: `No defaults configured for venue "${venue}"`,
          availableVenues: Object.keys(VENUE_CONSTANTS),
          globalDefault,
        });
      }

      const slippageBps = VENUE_SLIPPAGE_HINTS[venue.toLowerCase()] ?? config.defaultSlippageBps;
      return reply.send({
        ok: true,
        venue,
        defaults: { slippageBps, ...constants },
      });
    }

    // Return all venue defaults + global fallback
    const venues = Object.fromEntries(
      Object.entries(VENUE_CONSTANTS).map(([name, c]) => [
        name,
        { slippageBps: VENUE_SLIPPAGE_HINTS[name] ?? config.defaultSlippageBps, ...c },
      ])
    );

    return reply.send({
      ok: true,
      globalDefault,
      venues,
      guidance: 'Use venue-specific defaults when available, falling back to globalDefault. slippageBps is in basis points (1 bps = 0.01%). For create_bot.config.execution.slippageBps, use the venue value or globalDefault.slippageBps.',
    });
  });
}

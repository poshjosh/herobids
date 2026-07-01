import type {
  Strategy,
  MarketSnapshot,
  StrategyError,
  Decision,
  DecisionId,
  VenueAccountId,
  InstrumentId,
  Result,
} from '@herobids/domain';
import { ok, err, quantity } from '@herobids/domain';
import { z } from 'zod';

export const DcaParamsSchema = z.object({
  intervalMs: z.number().int().min(60_000).default(86_400_000),
  amountPerBuy: z.string()
    .min(1)
    .regex(/^\d+(\.\d+)?$/, 'amountPerBuy must be a valid decimal number'),
  amountPerBuyMode: z.enum(['fixed', 'percent_equity']).default('fixed'),
});

export type DcaParams = z.infer<typeof DcaParamsSchema>;

/**
 * Resolve the dollar-denominated DCA buy amount from the strategy params.
 *
 * When amountPerBuyMode is 'percent_equity', amountPerBuy is interpreted as
 * a percentage of account equity (e.g. "5" = 5% of equity). The equity value
 * must be injected into snapshot.data.accountEquity by the trading actor
 * before calling strategy.evaluate().
 *
 * Returns the dollar amount as a fixed-precision string, or '0' to signal
 * that a buy should be skipped (insufficient or missing equity data).
 */
function resolveDcaAmount(
  params: DcaParams,
  snapshot: MarketSnapshot,
): string {
  if (params.amountPerBuyMode === 'percent_equity') {
    const equity = snapshot.data?.['accountEquity'];
    if (typeof equity !== 'number' || equity <= 0) {
      return '0';
    }
    const pct = parseFloat(params.amountPerBuy);
    if (isNaN(pct) || pct <= 0) {
      return '0';
    }
    const amount = (equity * pct) / 100;
    // Guard against computed amounts that round to zero at 6 decimal places.
    // $0.01 is a reasonable minimum notional for any venue-supported trade.
    if (amount < 0.01) {
      return '0';
    }
    // 6 decimal places preserves sub-cent precision for small accounts
    // while being precise enough for crypto token quantities.
    return amount.toFixed(6);
  }
  return params.amountPerBuy;
}

export class DcaStrategy implements Strategy {
  readonly id = 'dca-v1';
  readonly name = 'DCA Strategy';

  async evaluate(
    snapshot: MarketSnapshot,
    rawConfig: Record<string, unknown>,
  ): Promise<Result<Decision | null, StrategyError>> {
    const parsed = DcaParamsSchema.safeParse(rawConfig);
    if (!parsed.success) {
      return err({
        code: 'strategy.config_invalid',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const { intervalMs } = parsed.data;

    // Check if enough time has passed since last buy
    const lastBuy = snapshot.data?.['lastDcaBuy'] as number | undefined;
    const now = Date.now();
    if (lastBuy != null && (now - lastBuy) < intervalMs) {
      return ok(null); // Not time yet
    }

    // Resolve buy amount (may be percent-of-equity)
    const buyAmount = resolveDcaAmount(parsed.data, snapshot);
    if (buyAmount === '0') {
      return ok(null); // Skip — insufficient equity or invalid params
    }

    return ok({
      id: crypto.randomUUID() as DecisionId,
      venueAccountId: '' as VenueAccountId, // stamped by TradingActor before intake
      actorType: 'system',
      actorId: 'dca-v1',
      instrumentId: snapshot.symbol as InstrumentId,
      intent: 'go_long',
      targetSize: quantity(buyAmount),
      timestamp: snapshot.timestamp,
      metadata: { strategy: 'dca', lastDcaBuy: now },
    });
  }
}

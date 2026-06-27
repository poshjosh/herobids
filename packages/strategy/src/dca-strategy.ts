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
});

export type DcaParams = z.infer<typeof DcaParamsSchema>;

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
    const { intervalMs, amountPerBuy } = parsed.data;

    // Check if enough time has passed since last buy
    const lastBuy = snapshot.data?.['lastDcaBuy'] as number | undefined;
    const now = Date.now();
    if (lastBuy != null && (now - lastBuy) < intervalMs) {
      return ok(null); // Not time yet
    }

    return ok({
      id: crypto.randomUUID() as DecisionId,
      venueAccountId: '' as VenueAccountId, // stamped by TradingActor before intake
      actorType: 'system',
      actorId: 'dca-v1',
      instrumentId: snapshot.symbol as InstrumentId,
      intent: 'go_long',
      targetSize: quantity(amountPerBuy),
      timestamp: snapshot.timestamp,
      metadata: { strategy: 'dca', lastDcaBuy: now },
    });
  }
}

/**
 * seed-usage-rate-card.ts — Ensures an active usage-billing rate card exists.
 *
 * Usage:
 *   pnpm --filter @herobids/scripts seed-usage-rate-card
 *
 * Env overrides:
 *   DATABASE_URL
 *   USAGE_BILLING_RATE_CARD (default: "default")
 */

import { createDatabase, UsageBillingRepository } from '@herobids/db';

const DEFAULT_DATABASE_URL = 'postgres://herobids:herobids@localhost:5432/herobids';

async function main() {
  const databaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const rateCardName = process.env['USAGE_BILLING_RATE_CARD'] ?? 'default';
  const db = createDatabase(databaseUrl);
  const repo = new UsageBillingRepository(db);

  const rateCard = await repo.ensureActiveRateCard(rateCardName);
  const items = await repo.getRateCardItems(rateCard.id);

  console.log(
    `[seed-usage-rate-card] Ensured active rate card '${rateCardName}' (id=${rateCard.id}) with ${items.length} item(s).`,
  );
}

main().catch((error: unknown) => {
  console.error('[seed-usage-rate-card] Fatal error:', error);
  process.exit(1);
});

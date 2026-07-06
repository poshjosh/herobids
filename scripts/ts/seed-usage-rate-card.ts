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

import { createDatabase, closeDatabase, UsageBillingRepository } from '@herobids/db';
import { loadProvidersConfig } from '@herobids/domain/config/load-providers';
import type { ProvidersYaml } from '@herobids/domain';

const DEFAULT_DATABASE_URL = 'postgres://herobids:herobids@localhost:5432/herobids';
const PROVIDERS_CONFIG_PATH = process.env['PROVIDERS_CONFIG_PATH'] ?? 'config/providers.yaml';

function loadWithFallback(path: string): ProvidersYaml | undefined {
  try {
    return loadProvidersConfig(path);
  } catch {
    console.warn(`[seed-usage-rate-card] Providers config not found at ${path} — skipping per-model rate card items`);
    return undefined;
  }
}

async function main() {
  const databaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const rateCardName = process.env['USAGE_BILLING_RATE_CARD'] ?? 'default';
  const providersYaml = loadWithFallback(PROVIDERS_CONFIG_PATH);
  const db = createDatabase(databaseUrl);
  try {
    const repo = new UsageBillingRepository(db, undefined, providersYaml);

    const rateCard = await repo.ensureActiveRateCard(rateCardName);
    const items = await repo.getRateCardItems(rateCard.id);

    console.log(
      `[seed-usage-rate-card] Ensured active rate card '${rateCardName}' (id=${rateCard.id}) with ${items.length} item(s).`,
    );
  } finally {
    await closeDatabase(db);
  }
}

main().catch((error: unknown) => {
  console.error('[seed-usage-rate-card] Fatal error:', error);
  process.exit(1);
});

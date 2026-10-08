/**
 * create-managed-payments-product.ts — Provisions the Stripe product + default
 * recurring price used for Managed Payments subscription checkout.
 *
 * Managed Payments delegates indirect tax compliance (sales tax, VAT, GST),
 * fraud prevention, and dispute/order management to Stripe. It requires:
 *   - a product carrying an eligible tax_code
 *     (https://docs.stripe.com/tax/tax-codes)
 *   - the `managed_payments[enabled]` checkout param, sent with Stripe-Version
 *     2026-02-25.preview or later
 *
 * This script is a one-time provisioning step, run manually by an operator —
 * it is not part of request-handling code, so it talks to Stripe's REST API
 * directly rather than importing @herobids/api internals (apps do not share
 * src/ across package boundaries in this monorepo).
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... tsx ts/create-managed-payments-product.ts \
 *     --name "Basic subscription" \
 *     --amount 1000 \
 *     --currency usd \
 *     --interval month \
 *     --tax-code txcd_10103100
 *
 * Obtain STRIPE_SECRET_KEY from the Stripe Dashboard (Developers > API keys).
 */

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const MANAGED_PAYMENTS_API_VERSION = '2026-02-25.preview';

interface Args {
  name: string;
  amountCents: number;
  currency: string;
  interval: 'day' | 'week' | 'month' | 'year';
  taxCode: string;
}

interface StripeProductResponse {
  id: string;
  name: string;
  default_price: string;
  error?: { message: string };
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };

  const name = get('--name') ?? 'Basic subscription';
  const amountRaw = get('--amount') ?? '1000';
  const currency = get('--currency') ?? 'usd';
  const interval = (get('--interval') ?? 'month') as Args['interval'];
  const taxCode = get('--tax-code') ?? 'txcd_10103100';

  const amountCents = Number.parseInt(amountRaw, 10);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error(`--amount must be a positive integer number of cents, got '${amountRaw}'`);
  }
  if (!['day', 'week', 'month', 'year'].includes(interval)) {
    throw new Error(`--interval must be one of day|week|month|year, got '${interval}'`);
  }

  return { name, amountCents, currency, interval, taxCode };
}

async function createManagedPaymentsProduct(secretKey: string, args: Args): Promise<StripeProductResponse> {
  const body = new URLSearchParams();
  body.set('name', args.name);
  body.set('tax_code', args.taxCode);
  body.set('default_price_data[currency]', args.currency);
  body.set('default_price_data[unit_amount]', String(args.amountCents));
  body.set('default_price_data[recurring][interval]', args.interval);

  const res = await fetch(`${STRIPE_API_BASE}/products`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': MANAGED_PAYMENTS_API_VERSION,
    },
    body: body.toString(),
  });

  const json = (await res.json()) as StripeProductResponse;
  if (!res.ok) {
    throw new Error(`Stripe API error creating product: ${json.error?.message ?? res.statusText}`);
  }
  return json;
}

async function main() {
  const secretKey = process.env['STRIPE_SECRET_KEY'];
  if (!secretKey) {
    console.error(
      '[create-managed-payments-product] STRIPE_SECRET_KEY is required. Obtain it from the Stripe Dashboard (Developers > API keys).',
    );
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const product = await createManagedPaymentsProduct(secretKey, args);

  console.log('[create-managed-payments-product] Created product:');
  console.log(`  product id: ${product.id}`);
  console.log(`  default price id: ${product.default_price}`);
  console.log('');
  console.log('Next step — add this to config/default.yaml (or an env-specific overlay):');
  console.log(`
billing:
  stripe:
    planPrices:
      <planId>:
        - stripePriceId: "${product.default_price}"
          interval: ${args.interval === 'year' ? 'year' : 'month'}
          displayLabel: "${args.name}"
          amountCents: ${args.amountCents}
          managedPayments: true
`);
}

main().catch((error: unknown) => {
  console.error('[create-managed-payments-product] Fatal error:', error);
  process.exit(1);
});

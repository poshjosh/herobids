// Boundary-backed PriceService adapter for hybrid USD-to-base-size conversion (Wave B1).
//
// `resolveHybridTargetSize` takes a `PriceService` and calls
// `resolvePriceTarget(symbol, chain, address)`, consuming the RESOLVED identity
// (symbol/chain/address/name) it returns. When the Traderton read boundary is
// present we back that call with the `resolve_price_target` read tool over REST
// instead of the in-process price service, preserving the resolved-identity
// metadata the hybrid decision flow pins against.
//
// Transport + shape mapping ONLY — no trading behaviour. The boundary tool takes
// `{symbol, chain}` and performs its OWN address detection from an address-shaped
// symbol (mirroring get_price / watch). The in-process resolver instead accepts
// an explicit `address` argument. To reproduce the in-process pinned-identity
// lookup across the boundary, we forward the pinned `address` AS the symbol when
// one is supplied (the tool's isOnChainAddress then re-detects it); otherwise we
// forward the ticker symbol. This is the same address-rides-as-symbol precedent
// established by the get_price and watch re-points.

import type {
  PriceService,
  PriceResult,
  PriceSource,
  ResolvePriceTargetResult,
} from '@herobids/market-data';
import type { TradertonReadBoundary } from './read-adapter.js';

const PRICE_SOURCES: readonly PriceSource[] = ['execution', 'oracle', 'cached'];

function isPriceSource(value: unknown): value is PriceSource {
  return typeof value === 'string' && (PRICE_SOURCES as readonly string[]).includes(value);
}

/**
 * Narrow the boundary's `unknown` success payload into a `ResolvedPriceTarget`.
 *
 * The payload originates from Traderton's `resolve_price_target` tool, whose
 * success shape is `{ ok, symbol, chain, address?, name?, priceUsd, source,
 * fetchedAt, stale }`. We validate the fields the hybrid flow depends on rather
 * than trusting the wire, returning `null` on any malformed field so the caller
 * fails closed instead of sizing off a garbage price.
 */
function narrowResolvedTarget(data: unknown): ResolvePriceTargetResult {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: { code: 'price.malformed', message: 'resolve_price_target returned a non-object payload' } };
  }

  const record = data as Record<string, unknown>;
  const { symbol, chain, address, name, priceUsd, source, fetchedAt, stale } = record;

  if (
    typeof symbol !== 'string' ||
    typeof chain !== 'string' ||
    typeof priceUsd !== 'number' ||
    !isPriceSource(source) ||
    typeof fetchedAt !== 'string' ||
    typeof stale !== 'boolean' ||
    (address !== undefined && typeof address !== 'string') ||
    (name !== undefined && typeof name !== 'string')
  ) {
    return { ok: false, error: { code: 'price.malformed', message: 'resolve_price_target payload missing required fields' } };
  }

  return {
    ok: true,
    data: {
      symbol,
      chain,
      ...(address !== undefined ? { address } : {}),
      ...(name !== undefined ? { name } : {}),
      priceUsd,
      source,
      fetchedAt,
      stale,
    },
  };
}

/**
 * Build a `PriceService`-shaped adapter that routes price resolution through the
 * Traderton read boundary. Only `resolvePriceTarget` is used by the hybrid sizing
 * path; `getPrice` is provided for `PriceService` conformance and projects the
 * resolved target down to the price-only shape, mirroring the in-process service.
 */
export function createBoundaryPriceService(boundary: TradertonReadBoundary): PriceService {
  async function resolvePriceTarget(
    symbol: string,
    chain: string,
    address?: string,
  ): Promise<ResolvePriceTargetResult> {
    // Pass the ticker `symbol` AND the pinned `address` through SEPARATELY —
    // the resolver searches DexScreener by `symbol` and then PREFERS the
    // exact-address match, so collapsing (ticker + address) into address-only
    // would change the search input and break parity with the in-process
    // resolvePriceTarget(symbol, chain, address). The boundary tool accepts an
    // optional `address` param for exactly this pinned-identity case.
    let result;
    try {
      result = await boundary.invoke({
        toolName: 'resolve_price_target',
        payload: { symbol, chain, ...(address ? { address } : {}) },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: 'price.transport_error', message } };
    }

    switch (result.kind) {
      case 'success':
        return narrowResolvedTarget(result.data);
      case 'failure':
        return { ok: false, error: { code: result.code, message: result.message } };
      case 'transport_error':
        return { ok: false, error: { code: 'price.transport_error', message: result.message } };
      case 'in_progress':
        return { ok: false, error: { code: 'price.in_progress', message: 'resolve_price_target did not complete within the deadline' } };
    }
  }

  async function getPrice(symbol: string, chain: string, address?: string): Promise<PriceResult> {
    const result = await resolvePriceTarget(symbol, chain, address);
    if (!result.ok) {
      return result;
    }
    const { priceUsd, source, fetchedAt, stale } = result.data;
    return { ok: true, data: { priceUsd, source, fetchedAt, stale } };
  }

  return { getPrice, resolvePriceTarget };
}

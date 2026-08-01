/**
 * Venue-specific trade instrument validation.
 *
 * Replaces the generic `instrumentCache.hasSymbol()` check with logic that
 * understands the semantics of each venue type:
 *
 *   - Orderbook venues (hyperliquid, bybit): reuse the existing cache lookup.
 *   - Jupiter: validate exact mint addresses against the ready token cache.
 *   - 1inch: validate EVM address syntax, resolved Base network, and
 *     canonical quote address — without requiring base in curated cache.
 */

import { parseSwapInstrumentId } from './swap-instrument-id.js';
import type { VenueInstrumentCache } from './venue-instrument-cache.js';
import { resolveSwapNetwork } from './resolve-swap-assets.js';
import type { BindingLike } from './resolve-swap-assets.js';

export interface ValidateTradeInstrumentConfig {
  /** 1inch operator-level config for network resolution */
  oneInchConfig?: { tokenSafetyNetwork?: string; chainId?: number };
  /**
   * Canonical token definitions keyed by lowercased network, then by uppercase
   * symbol.  Passed so we can validate the quote address against known
   * canonical entries for swap venues.
   */
  canonicalTokens?: Record<string, Record<string, { address: string; name: string; aliases: string[] }>>;
  /**
   * Binding-level profile — carried from the active connection so that
   * binding-specific `chainId` / `network` overrides take precedence
   * over operator defaults when resolving the 1inch network.
   */
  bindingProfile?: Record<string, unknown> | null;
}

export interface ValidateTradeInstrumentResult {
  valid: boolean;
  reason?: string;
}

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Validate that an instrument ID is recognised and executable on a given venue.
 *
 * For orderbook venues the existing cache lookup is preserved unchanged.
 * For swap venues the instrument ID is parsed and validated according to
 * venue-specific rules.
 */
export function validateTradeInstrument(
  venue: string,
  instrumentId: string,
  instrumentCache: VenueInstrumentCache,
  config: ValidateTradeInstrumentConfig = {},
): ValidateTradeInstrumentResult {
  // Orderbook venues: standard cache check
  if (venue !== 'jupiter' && venue !== '1inch') {
    if (instrumentCache.isReady() && !instrumentCache.hasSymbol(venue, instrumentId)) {
      return { valid: false, reason: `'${instrumentId}' is not a recognized instrument on ${venue}` };
    }
    return { valid: true };
  }

  // Swap venues: parse the instrument ID first
  let parsed;
  try {
    parsed = parseSwapInstrumentId(instrumentId);
  } catch (e) {
    return { valid: false, reason: `'${instrumentId}' is not a valid swap instrument ID: ${(e as Error).message}` };
  }

  // ── Jupiter validation ──────────────────────────────────────────────────
  if (venue === 'jupiter') {
    return validateJupiterInstrument(parsed, instrumentCache);
  }

  // ── 1inch validation ────────────────────────────────────────────────────
  if (venue === '1inch') {
    return validate1InchInstrument(parsed, config);
  }

  return { valid: true };
}

// ── Jupiter-specific helpers ────────────────────────────────────────────────

function validateJupiterInstrument(
  parsed: ReturnType<typeof parseSwapInstrumentId>,
  instrumentCache: VenueInstrumentCache,
): ValidateTradeInstrumentResult {
  // When both addresses are present (exact scanner ID), validate each
  // against the ready Jupiter token cache.
  if (parsed.isExact) {
    return validateJupiterExact(parsed, instrumentCache);
  }

  // When only the base address is present, validate base against cache.
  // Quote is a display symbol that must exist in the cache.
  if (parsed.baseAddress !== null) {
    return validateJupiterBaseQualified(parsed, instrumentCache);
  }

  // Legacy plain pair: cache lookup by display symbol
  return validateJupiterLegacy(parsed, instrumentCache);
}

function validateJupiterExact(
  parsed: ReturnType<typeof parseSwapInstrumentId>,
  instrumentCache: VenueInstrumentCache,
): ValidateTradeInstrumentResult {
  // Cache must be ready for address-level validation
  if (!instrumentCache.isReady() || !instrumentCache.isVenueReady('jupiter')) {
    // Cache not ready — fail-open (the old hasSymbol behavior for unknown venues).
    return { valid: true };
  }

  const baseAddr = parsed.baseAddress!;
  const quoteAddr = parsed.quoteAddress!;

  if (!instrumentCache.hasSymbol('jupiter', baseAddr)) {
    return {
      valid: false,
      reason: `Base token address '${baseAddr}' not found in Jupiter token cache`,
    };
  }
  if (!instrumentCache.hasSymbol('jupiter', quoteAddr)) {
    return {
      valid: false,
      reason: `Quote token address '${quoteAddr}' not found in Jupiter token cache`,
    };
  }

  return { valid: true };
}

function validateJupiterBaseQualified(
  parsed: ReturnType<typeof parseSwapInstrumentId>,
  instrumentCache: VenueInstrumentCache,
): ValidateTradeInstrumentResult {
  if (!instrumentCache.isReady() || !instrumentCache.isVenueReady('jupiter')) {
    return { valid: true };
  }

  const baseAddr = parsed.baseAddress!;
  if (!instrumentCache.hasSymbol('jupiter', baseAddr)) {
    return {
      valid: false,
      reason: `Base token address '${baseAddr}' not found in Jupiter token cache`,
    };
  }

  // Quote is symbolic — check via display symbol
  if (!instrumentCache.hasSymbol('jupiter', parsed.quoteSymbol)) {
    return {
      valid: false,
      reason: `Quote token '${parsed.quoteSymbol}' is not a recognized instrument on jupiter`,
    };
  }

  return { valid: true };
}

function validateJupiterLegacy(
  parsed: ReturnType<typeof parseSwapInstrumentId>,
  instrumentCache: VenueInstrumentCache,
): ValidateTradeInstrumentResult {
  if (instrumentCache.isReady() && !instrumentCache.hasSymbol('jupiter', parsed.displaySymbol)) {
    return {
      valid: false,
      reason: `'${parsed.displaySymbol}' is not a recognized instrument on jupiter`,
    };
  }
  return { valid: true };
}

// ── 1inch-specific helpers ──────────────────────────────────────────────────

function validate1InchInstrument(
  parsed: ReturnType<typeof parseSwapInstrumentId>,
  config: ValidateTradeInstrumentConfig,
): ValidateTradeInstrumentResult {
  // When both addresses are present (exact scanner ID), validate structurally.
  if (parsed.isExact) {
    return validate1InchExact(parsed, config);
  }

  // When only the base address is present, validate base address format.
  if (parsed.baseAddress !== null) {
    return validate1InchBaseQualified(parsed, config);
  }

  // Legacy plain pair: structural validation only (no curated cache required).
  return { valid: true };
}

function validate1InchExact(
  parsed: ReturnType<typeof parseSwapInstrumentId>,
  config: ValidateTradeInstrumentConfig,
): ValidateTradeInstrumentResult {
  const baseAddr = parsed.baseAddress!;
  const quoteAddr = parsed.quoteAddress!;

  // Validate EVM hex format for both addresses
  if (!EVM_ADDRESS_RE.test(baseAddr)) {
    return {
      valid: false,
      reason: `Base token address '${baseAddr}' is not a valid EVM address (expected 0x-prefixed 40-char hex)`,
    };
  }
  if (!EVM_ADDRESS_RE.test(quoteAddr)) {
    return {
      valid: false,
      reason: `Quote token address '${quoteAddr}' is not a valid EVM address (expected 0x-prefixed 40-char hex)`,
    };
  }

  // Resolve the network for 1inch, respecting binding-level chainId / network overrides.
  const bindingForNetwork: BindingLike | undefined = config.bindingProfile
    ? { id: '', bindingProfile: config.bindingProfile }
    : undefined;
  const network = resolveSwapNetwork('1inch', bindingForNetwork, config.oneInchConfig);
  if (!network) {
    return {
      valid: false,
      reason: 'Cannot determine 1inch network for instrument validation',
    };
  }
  if (network !== 'base') {
    return {
      valid: false,
      reason: `1inch network '${network}' is not supported for scanner trading (only 'base' is supported)`,
    };
  }

  // Validate quote address against canonical USDC for the matched network
  const canonical = findCanonicalBySymbol('USDC', network, config.canonicalTokens);
  if (!canonical) {
    return {
      valid: false,
      reason: `No canonical USDC address configured for network '${network}'`,
    };
  }

  // EVM addresses are case-insensitive
  if (canonical.address.toLowerCase() !== quoteAddr.toLowerCase()) {
    return {
      valid: false,
      reason: `Quote address '${quoteAddr}' does not match canonical USDC address '${canonical.address}' for network '${network}'`,
    };
  }

  return { valid: true };
}

function validate1InchBaseQualified(
  parsed: ReturnType<typeof parseSwapInstrumentId>,
  config: ValidateTradeInstrumentConfig,
): ValidateTradeInstrumentResult {
  const baseAddr = parsed.baseAddress!;

  // Validate EVM hex format for base address
  if (!EVM_ADDRESS_RE.test(baseAddr)) {
    return {
      valid: false,
      reason: `Base token address '${baseAddr}' is not a valid EVM address (expected 0x-prefixed 40-char hex)`,
    };
  }

  // Resolve the network for 1inch, respecting binding-level chainId / network overrides.
  const bindingForNetwork: BindingLike | undefined = config.bindingProfile
    ? { id: '', bindingProfile: config.bindingProfile }
    : undefined;
  const network = resolveSwapNetwork('1inch', bindingForNetwork, config.oneInchConfig);
  if (!network) {
    return {
      valid: false,
      reason: 'Cannot determine 1inch network for instrument validation',
    };
  }
  if (network !== 'base') {
    return {
      valid: false,
      reason: `1inch network '${network}' is not supported for scanner trading (only 'base' is supported)`,
    };
  }

  return { valid: true };
}

// ── Canonical token helpers ─────────────────────────────────────────────────

function findCanonicalBySymbol(
  symbol: string,
  network: string,
  canonicalTokens?: Record<string, Record<string, { address: string; name: string; aliases: string[] }>>,
): { address: string; name: string; aliases: string[] } | undefined {
  if (!canonicalTokens) return undefined;
  const networkMap = canonicalTokens[network.toLowerCase()];
  if (!networkMap) return undefined;
  return networkMap[symbol.toUpperCase()];
}

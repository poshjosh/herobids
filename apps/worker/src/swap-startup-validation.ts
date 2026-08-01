/**
 * Swap scanner startup validation — extracted from index.ts for testability.
 *
 * Validates that a swap-bound scanner_gated agent has a coherent configuration:
 * the binding network is resolved, not excluded by filters, and the quote asset
 * is a recognized canonical token.
 */

import type { TechnicalConfig, TokenSafetyConfig } from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import type { SupportedTokenSafetyNetwork } from '@herobids/domain';

export interface ValidatedSwapConfig {
  network: SupportedTokenSafetyNetwork;
  quoteAssetSymbol: string;
}

export type SwapValidationError = {
  code: string;
  message: string;
};

/**
 * Validate that a swap-bound scanner agent has a coherent configuration.
 *
 * Checks (in order):
 *  1. Binding network is resolved
 *  2. Network is not excluded by filters.networks
 *  3. Canonical tokens are configured for the network
 *  4. The quote asset symbol is a recognized canonical token
 *
 * Returns `ok(validated)` on success or `err(error)` with a descriptive
 * dot-namespaced error code.
 */
export function validateSwapScannerConfig(
  resolvedSwapNetwork: SupportedTokenSafetyNetwork | undefined,
  venue: string,
  technicalConfig: TechnicalConfig,
  canonicalTokens: TokenSafetyConfig['canonicalTokens'] | undefined,
): Result<ValidatedSwapConfig, SwapValidationError> {
  // 1. Binding network must be resolved
  if (!resolvedSwapNetwork) {
    return err({
      code: 'swap.network_unresolved',
      message:
        `Binding network is unresolved (venue=${venue}). ` +
        'The agent is configured as scanner_gated + swap but the binding network could not be determined.',
    });
  }

  // 2. Network must not be excluded by filters
  const filterNetworks = technicalConfig.filters.networks;
  if (filterNetworks && filterNetworks.length > 0 && !filterNetworks.includes(resolvedSwapNetwork)) {
    return err({
      code: 'swap.network_excluded',
      message:
        `filters.networks (${filterNetworks.join(', ')}) excludes the binding network '${resolvedSwapNetwork}'. ` +
        'A swap-bound agent must scan on its binding network.',
    });
  }

  // 3. Canonical tokens must be configured for the network
  const networkTokens = canonicalTokens?.[resolvedSwapNetwork];
  if (!networkTokens || Object.keys(networkTokens).length === 0) {
    return err({
      code: 'swap.no_canonical_tokens',
      message:
        `No canonical tokens configured for network '${resolvedSwapNetwork}'. ` +
        'Populate marketData.tokenSafety.canonicalTokens in operator config before enabling swap scanning.',
    });
  }

  // 4. Quote asset must be a recognized canonical token
  const quoteSymbol = technicalConfig.filters.quoteAssetSymbol ?? 'USDC';
  if (!(quoteSymbol in networkTokens)) {
    const available = Object.keys(networkTokens).join(', ');
    return err({
      code: 'swap.quote_not_canonical',
      message:
        `quoteAssetSymbol '${quoteSymbol}' is not a canonical token on network '${resolvedSwapNetwork}'. ` +
        `Available: ${available}. Update technical.filters.quoteAssetSymbol or add '${quoteSymbol}' to operator config.`,
    });
  }

  // 5. Quote asset canonical token must have an address for cross-validation
  const quoteToken = networkTokens[quoteSymbol]!;
  if (!quoteToken.address) {
    return err({
      code: 'swap.quote_address_missing',
      message:
        `Canonical token '${quoteSymbol}' on network '${resolvedSwapNetwork}' has no address. ` +
        'Populate the address field in marketData.tokenSafety.canonicalTokens before enabling swap scanning.',
    });
  }

  return ok({ network: resolvedSwapNetwork, quoteAssetSymbol: quoteSymbol });
}

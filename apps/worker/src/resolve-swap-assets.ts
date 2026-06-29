/**
 * Resolves swap asset metadata from a trading connection's profile.
 * Used at agent startup when the venue type is 'swap' — the binding carries
 * the specific asset pair the agent will trade.
 */

import { inferOneInchTokenSafetyNetwork, SUPPORTED_TOKEN_SAFETY_NETWORKS } from '@herobids/domain';
import type { SupportedTokenSafetyNetwork } from '@herobids/domain';

export interface SwapAssets {
  baseAsset: string;
  quoteAsset: string;
  baseDecimals: number;
  quoteDecimals: number;
}

export interface BindingLike {
  id: string;
  bindingProfile?: Record<string, unknown> | null;
}

/**
 * Resolve the token-safety network for a swap venue binding.
 *
 * For Jupiter this is always `'solana'`.  For 1inch the network is read from
 * the binding profile (field `network` or `chainId`) when present, then falls
 * back to the operator-level 1inch config.  Returns `undefined` for non-swap
 * venues or when no chain mapping can be determined.
 */
export function resolveSwapNetwork(
  venue: string,
  binding?: BindingLike,
  oneInchConfig?: { tokenSafetyNetwork?: string; chainId?: number },
): SupportedTokenSafetyNetwork | undefined {
  if (venue === 'jupiter') return 'solana';

  if (venue === '1inch') {
    // 1. Binding profile — explicit network field
    const profileNetwork = binding?.bindingProfile?.network;
    if (typeof profileNetwork === 'string') {
      const validNetworks: readonly string[] = SUPPORTED_TOKEN_SAFETY_NETWORKS;
      if (validNetworks.includes(profileNetwork)) {
        return profileNetwork as SupportedTokenSafetyNetwork;
      }
      // Explicit but unrecognised network — fall through to chainId / operator
      // config rather than trusting an unvalidated database value.
    }

    // 2. Binding profile — chainId → network mapping
    const profileChainId = binding?.bindingProfile?.chainId;
    if (typeof profileChainId === 'number') {
      const inferred = inferOneInchTokenSafetyNetwork(profileChainId);
      if (inferred) return inferred;
      // Explicit chainId that we cannot map — fail closed.
      // Do NOT fall back to operator config; an unsupported binding
      // chain must surface as an error, not silently route to Base.
      return undefined;
    }

    // 3. Operator config — explicit tokenSafetyNetwork
    if (oneInchConfig?.tokenSafetyNetwork) {
      return oneInchConfig.tokenSafetyNetwork as SupportedTokenSafetyNetwork;
    }

    // 4. Operator config — chainId → network mapping
    if (oneInchConfig?.chainId != null) {
      return inferOneInchTokenSafetyNetwork(oneInchConfig.chainId);
    }

    return undefined;
  }

  return undefined;
}

/**
 * Extract swapAssets metadata from a binding's profile.
 * Returns undefined if the required fields are missing — callers should
 * fail with a descriptive error in that case.
 */
export function resolveSwapAssetsFromBinding(binding: BindingLike): SwapAssets | undefined {
  const profile = binding.bindingProfile;
  if (!profile) return undefined;

  // Check for nested swapAssets object first
  const nested = profile.swapAssets as Record<string, unknown> | undefined;
  if (nested && typeof nested === 'object') {
    const base = nested.baseAsset;
    const quote = nested.quoteAsset;
    const baseDec = nested.baseDecimals;
    const quoteDec = nested.quoteDecimals;
    if (typeof base === 'string' && typeof quote === 'string' &&
        typeof baseDec === 'number' && typeof quoteDec === 'number') {
      return { baseAsset: base, quoteAsset: quote, baseDecimals: baseDec, quoteDecimals: quoteDec };
    }
  }

  // Flat layout: profile.baseAsset + profile.quoteAsset + profile.baseDecimals + profile.quoteDecimals
  const base = profile.baseAsset;
  const quote = profile.quoteAsset;
  const baseDec = profile.baseDecimals;
  const quoteDec = profile.quoteDecimals;
  if (typeof base === 'string' && typeof quote === 'string' &&
      typeof baseDec === 'number' && typeof quoteDec === 'number') {
    return { baseAsset: base, quoteAsset: quote, baseDecimals: baseDec, quoteDecimals: quoteDec };
  }

  return undefined;
}

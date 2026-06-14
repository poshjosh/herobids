/**
 * Resolves swap asset metadata from a trading binding's profile.
 * Used at agent startup when the venue type is 'swap' — the binding carries
 * the specific asset pair the agent will trade.
 */

export interface SwapAssets {
  baseAsset: string;
  quoteAsset: string;
  baseDecimals: number;
  quoteDecimals: number;
}

interface BindingLike {
  id: string;
  bindingProfile?: Record<string, unknown> | null;
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

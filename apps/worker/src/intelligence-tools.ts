import type { BybitCrowdingSignal, HyperliquidAssetContext, ProviderRegistry } from '@herobids/market-data';

interface IntelligenceToolHooks {
  onAttempt?: (provider: string) => void;
}

export async function executeDiscoverTokensTool(
  marketDataRegistry: ProviderRegistry,
  args: Record<string, unknown>,
  hooks?: IntelligenceToolHooks,
): Promise<Record<string, unknown>> {
  hooks?.onAttempt?.('aggregated-discovery');
  const discoveryResult = await marketDataRegistry.discovery.discover({
    networks: typeof args['network'] === 'string' ? [args['network'] as string] : undefined,
    maxResults: typeof args['limit'] === 'number' ? args['limit'] : undefined,
    minLiquidityUsd: typeof args['minLiquidityUsd'] === 'number' ? args['minLiquidityUsd'] : undefined,
  });
  return { ok: true, tokens: discoveryResult.data, freshness: discoveryResult.meta.freshness };
}

export async function executeFundingRatesTool(
  marketDataRegistry: ProviderRegistry,
  args: Record<string, unknown>,
  hooks?: IntelligenceToolHooks,
): Promise<Record<string, unknown>> {
  hooks?.onAttempt?.('hyperliquid');
  const assetContexts = await marketDataRegistry.hyperliquid.assetContexts();
  const requestedSymbols = Array.isArray(args['symbols'])
    ? new Set((args['symbols'] as Array<unknown>).filter((symbol): symbol is string => typeof symbol === 'string').map((symbol) => symbol.toUpperCase()))
    : null;
  const assets = assetContexts.data
    .filter((asset: HyperliquidAssetContext) => !requestedSymbols || requestedSymbols.has(asset.asset.toUpperCase()))
    .sort((left: HyperliquidAssetContext, right: HyperliquidAssetContext) => (right.openInterest ?? 0) - (left.openInterest ?? 0))
    .slice(0, requestedSymbols ? undefined : 10)
    .map((asset: HyperliquidAssetContext) => ({
      symbol: asset.asset,
      fundingRate: asset.fundingRate,
      fundingAnnualizedPct: asset.annualizedFundingRatePct,
      openInterest: asset.openInterest,
      markPrice: asset.markPrice,
      oraclePrice: asset.oraclePrice,
      volume24hUsd: asset.volume24hUsd,
    }));

  return { ok: true, assets, freshness: assetContexts.meta.freshness };
}

export async function executeMarketOverviewTool(
  marketDataRegistry: ProviderRegistry,
  args: Record<string, unknown>,
  hooks?: IntelligenceToolHooks,
): Promise<Record<string, unknown>> {
  const venue = typeof args['venue'] === 'string' ? args['venue'] : 'hyperliquid';
  hooks?.onAttempt?.('hyperliquid');
  const assetContexts = await marketDataRegistry.hyperliquid.assetContexts();
  const requestedSymbols = Array.isArray(args['symbols'])
    ? (args['symbols'] as Array<unknown>).filter((symbol): symbol is string => typeof symbol === 'string').map((symbol) => symbol.toUpperCase())
    : assetContexts.data
      .sort((left: HyperliquidAssetContext, right: HyperliquidAssetContext) => (right.volume24hUsd ?? 0) - (left.volume24hUsd ?? 0))
      .slice(0, 5)
      .map((asset: HyperliquidAssetContext) => asset.asset.toUpperCase());

  const ratioEntries: Array<readonly [string, BybitCrowdingSignal | null]> = venue === 'bybit'
    ? await Promise.all(requestedSymbols.map(async (symbol: string) => {
        hooks?.onAttempt?.('bybit');
        const ratio = await marketDataRegistry.bybit.longShortRatio(`${symbol}USDT`);
        return [symbol, ratio.data[0] ?? null] as const;
      }))
    : [];
  const ratioMap = new Map<string, BybitCrowdingSignal | null>(ratioEntries);

  const overview = assetContexts.data
    .filter((asset: HyperliquidAssetContext) => requestedSymbols.includes(asset.asset.toUpperCase()))
    .map((asset: HyperliquidAssetContext) => ({
      symbol: asset.asset,
      price: asset.markPrice,
      change24hPct: asset.priceChange24hPct,
      volume24hUsd: asset.volume24hUsd,
      fundingRate: asset.fundingRate,
      openInterest: asset.openInterest,
      longShortRatio: ratioMap.get(asset.asset.toUpperCase())?.longShortRatio ?? null,
    }));

  return { ok: true, overview, freshness: assetContexts.meta.freshness };
}
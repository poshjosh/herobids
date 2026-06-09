import type { HyperliquidAssetContext, RequestGate } from './types.js';
import { fetchJson } from './http.js';

interface HyperliquidMetaResponse {
  universe?: Array<{ name?: string }>;
}

interface HyperliquidAssetRaw {
  funding?: string;
  openInterest?: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
  markPx?: string;
  midPx?: string;
  oraclePx?: string;
}

type HyperliquidInfoResponse = [HyperliquidMetaResponse, HyperliquidAssetRaw[]];

export interface HyperliquidInfoConfig {
  baseUrl: string;
  intelligencePath?: string;
  rateLimiter: RequestGate;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function fetchHyperliquidAssetContexts(
  config: HyperliquidInfoConfig,
): Promise<HyperliquidAssetContext[]> {
  await config.rateLimiter.acquire();

  const response = await fetchJson<HyperliquidInfoResponse>({
    url: `${config.baseUrl}${config.intelligencePath ?? '/info'}`,
    timeoutMs: config.timeoutMs,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    fetchFn: config.fetchFn,
  });

  const meta = response[0]?.universe ?? [];
  const contexts = response[1] ?? [];

  return contexts.map((context, index): HyperliquidAssetContext => {
    const fundingRate = parseOptionalNumber(context.funding);
    const openInterest = parseOptionalNumber(context.openInterest);
    const markPrice = parseOptionalNumber(context.markPx);
    const midPrice = parseOptionalNumber(context.midPx);
    const oraclePrice = parseOptionalNumber(context.oraclePx);
    const volume24hUsd = parseOptionalNumber(context.dayNtlVlm);
    const prevDayPrice = parseOptionalNumber(context.prevDayPx);
    const annualizedFundingRatePct = fundingRate === null ? null : fundingRate * 8_760 * 100;
    const markOracleSpreadPct =
      markPrice !== null && oraclePrice !== null && oraclePrice !== 0
        ? ((markPrice - oraclePrice) / oraclePrice) * 100
        : null;
    const priceChange24hPct =
      markPrice !== null && prevDayPrice !== null && prevDayPrice !== 0
        ? ((markPrice - prevDayPrice) / prevDayPrice) * 100
        : null;

    return {
      asset: meta[index]?.name ?? `asset-${index}`,
      fundingRate,
      annualizedFundingRatePct,
      openInterest,
      markPrice,
      midPrice,
      oraclePrice,
      markOracleSpreadPct,
      volume24hUsd,
      prevDayPrice,
      priceChange24hPct,
    };
  });
}
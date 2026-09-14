import type { RegimeResult } from '@herobids/market-data';
import type { EconomicEvent } from '@herobids/domain';
import type { RuntimePositionSnapshot, RuntimeSessionMetrics } from './runtime-composition.js';

// ── Traderton read-boundary payload parsers ────────────────────────────────
//
// The B2 re-point routes the regime tick-gate + venue-intelligence reads over
// the Traderton READ boundary (`check_regime`, `get_market_overview`,
// `discover_tokens`, `search_tokens`). Boundary payloads arrive as `unknown`
// over REST, so these helpers narrow them into the exact in-process shapes the
// consumers already build — preserving every field, freshness, and telemetry
// hook without a behaviour change. They are pure (no I/O) and unit-tested; the
// agent-runtime wiring calls them behind the boundary-present gate and keeps
// the in-process registry path as the fallback when the boundary is absent.

/** The `{ isStale, ageMs }` subset the venue-intel `providerFreshness` helper consumes. */
export interface BoundaryFreshness {
  isStale: boolean;
  ageMs: number;
}

/** Narrow a boundary `freshness` object (`unknown` over the wire) to `{ isStale, ageMs }`. */
function parseBoundaryFreshness(value: unknown): BoundaryFreshness {
  const record = (value && typeof value === 'object') ? (value as Record<string, unknown>) : {};
  return {
    isStale: record['isStale'] === true,
    ageMs: typeof record['ageMs'] === 'number' ? record['ageMs'] : 0,
  };
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Narrow the `get_economic_calendar` boundary success payload (`unknown` over
 * the wire) to the `EconomicEvent[]` the macro-economic context block consumes.
 * The boundary returns `{ ok, events: EconomicEvent[], sources, fetchedAt }` —
 * a missing/malformed payload (or non-array `events`) degrades to an empty
 * array so the caller omits the macro block for that tick. The events array is
 * passed through (object entries only); event fields are not re-validated here
 * since the renderer tolerates partial events.
 */
export function parseEconomicCalendarBoundaryPayload(data: unknown): EconomicEvent[] {
  if (data && typeof data === 'object') {
    const events = (data as Record<string, unknown>)['events'];
    if (Array.isArray(events)) {
      return events.filter((e): e is EconomicEvent => e != null && typeof e === 'object');
    }
  }
  return [];
}

/** Freshness re-sourced from a `check_regime` boundary success payload (parity with the coordinator). */
export interface RegimeBoundaryFreshness {
  provider: string;
  source: 'upstream' | 'cache';
  ageMs: number;
  isStale: boolean;
}

/** A `check_regime` boundary success payload narrowed into the in-process `RegimeResult` + freshness. */
export interface ParsedRegimeBoundaryPayload {
  regime: RegimeResult;
  freshness: RegimeBoundaryFreshness | null;
}

function parseRegimeDetails(value: unknown): RegimeResult['details'] {
  const d = (value && typeof value === 'object') ? (value as Record<string, unknown>) : {};
  const emaAlignment = d['emaAlignment'] === 'bearish' ? 'bearish' : 'bullish';
  const marketStructure =
    d['marketStructure'] === 'higherHighs' ? 'higherHighs'
      : d['marketStructure'] === 'lowerHighs' ? 'lowerHighs'
        : 'mixed';
  const num = (key: string): number => (typeof d[key] === 'number' && Number.isFinite(d[key]) ? d[key] as number : 0);
  return {
    benchmarkSymbol: typeof d['benchmarkSymbol'] === 'string' ? d['benchmarkSymbol'] : '',
    currentPrice: num('currentPrice'),
    emaFast: num('emaFast'),
    emaSlow: num('emaSlow'),
    emaTrend: num('emaTrend'),
    emaAlignment,
    adxValue: num('adxValue'),
    choppy: d['choppy'] === true,
    vwap: num('vwap'),
    priceAboveVwap: d['priceAboveVwap'] === true,
    marketStructure,
  };
}

/**
 * Narrow a `check_regime` boundary success payload into the in-process
 * `RegimeResult` the tick gate consumes (`pass`/`reasons`/`details`) plus the
 * freshness the runtime re-sources into its regime telemetry (parity with the
 * coordinator's `parseRegimePayload`).
 */
export function parseRegimeBoundaryPayload(data: unknown): ParsedRegimeBoundaryPayload {
  const record = (data && typeof data === 'object') ? (data as Record<string, unknown>) : {};
  const rawFreshness = record['freshness'];
  let freshness: RegimeBoundaryFreshness | null = null;
  if (rawFreshness && typeof rawFreshness === 'object') {
    const f = rawFreshness as Record<string, unknown>;
    freshness = {
      provider: typeof f['provider'] === 'string' ? f['provider'] : 'binance',
      source: f['source'] === 'cache' ? 'cache' : 'upstream',
      ageMs: typeof f['ageMs'] === 'number' ? f['ageMs'] : 0,
      isStale: f['isStale'] === true,
    };
  }
  return {
    regime: {
      pass: record['pass'] === true,
      reasons: Array.isArray(record['reasons'])
        ? (record['reasons'] as unknown[]).filter((r): r is string => typeof r === 'string')
        : [],
      details: parseRegimeDetails(record['details']),
    },
    freshness,
  };
}

/** A single `get_market_overview` per-symbol entry narrowed from the boundary payload. */
export interface MarketOverviewEntry {
  symbol: string;
  price: number | null;
  change24hPct: number | null;
  volume24hUsd: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  markOracleSpreadPct: number | null;
  longShortRatio: number | null;
}

/** A `get_market_overview` boundary success payload narrowed into per-symbol entries + freshness. */
export interface ParsedMarketOverviewPayload {
  overview: MarketOverviewEntry[];
  freshness: BoundaryFreshness;
}

/**
 * Narrow a `get_market_overview` boundary success payload into the per-symbol
 * fields the perps venue-intelligence signal consumes. Every field the source
 * tool returns (`symbol`, `price`, `change24hPct`, `volume24hUsd`,
 * `fundingRate`, `openInterest`, `markOracleSpreadPct`, `longShortRatio`) is
 * preserved so the signal is byte-for-byte equivalent to the in-process path.
 */
export function parseMarketOverviewPayload(data: unknown): ParsedMarketOverviewPayload {
  const record = (data && typeof data === 'object') ? (data as Record<string, unknown>) : {};
  const rawOverview = Array.isArray(record['overview']) ? record['overview'] : [];
  const overview: MarketOverviewEntry[] = rawOverview.map((raw) => {
    const o = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
    return {
      symbol: typeof o['symbol'] === 'string' ? o['symbol'] : '',
      price: toNullableNumber(o['price']),
      change24hPct: toNullableNumber(o['change24hPct']),
      volume24hUsd: toNullableNumber(o['volume24hUsd']),
      fundingRate: toNullableNumber(o['fundingRate']),
      openInterest: toNullableNumber(o['openInterest']),
      markOracleSpreadPct: toNullableNumber(o['markOracleSpreadPct']),
      longShortRatio: toNullableNumber(o['longShortRatio']),
    };
  });
  return { overview, freshness: parseBoundaryFreshness(record['freshness']) };
}

/**
 * A DEX token narrowed from a `discover_tokens` / `search_tokens` boundary
 * payload. Carries exactly the fields the venue-intel DEX signal consumes
 * (verified against the source tools: `priceUsd`, `liquidityUsd`,
 * `volume24hUsd`, `priceChange24hPct`, `network`, `address`, `symbol`,
 * `poolCreatedAt`, `discoveryVectors`).
 */
export interface DexBoundaryToken {
  symbol: string;
  network: string;
  address: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  priceChange24hPct: number;
  poolCreatedAt: string | null;
  discoveryVectors: string[];
}

function parseDexToken(raw: unknown): DexBoundaryToken {
  const t = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  return {
    symbol: typeof t['symbol'] === 'string' ? t['symbol'] : '',
    network: typeof t['network'] === 'string' ? t['network'] : '',
    address: typeof t['address'] === 'string' ? t['address'] : '',
    priceUsd: typeof t['priceUsd'] === 'number' ? t['priceUsd'] : 0,
    liquidityUsd: typeof t['liquidityUsd'] === 'number' ? t['liquidityUsd'] : 0,
    volume24hUsd: typeof t['volume24hUsd'] === 'number' ? t['volume24hUsd'] : 0,
    priceChange24hPct: typeof t['priceChange24hPct'] === 'number' ? t['priceChange24hPct'] : 0,
    poolCreatedAt: typeof t['poolCreatedAt'] === 'string' ? t['poolCreatedAt'] : null,
    discoveryVectors: Array.isArray(t['discoveryVectors'])
      ? (t['discoveryVectors'] as unknown[]).filter((v): v is string => typeof v === 'string')
      : [],
  };
}

/** A `discover_tokens` / `search_tokens` boundary success payload narrowed into tokens + freshness. */
export interface ParsedDexTokensPayload {
  tokens: DexBoundaryToken[];
  freshness: BoundaryFreshness;
}

/** Narrow a `discover_tokens` or `search_tokens` boundary success payload into DEX tokens + freshness. */
export function parseDexTokensPayload(data: unknown): ParsedDexTokensPayload {
  const record = (data && typeof data === 'object') ? (data as Record<string, unknown>) : {};
  const rawTokens = Array.isArray(record['tokens']) ? record['tokens'] : [];
  return {
    tokens: rawTokens.map(parseDexToken),
    freshness: parseBoundaryFreshness(record['freshness']),
  };
}

/**
 * Build a map from `${network}:${SYMBOL}` to a discovered token object.
 * Using a composite key prevents cross-chain ticker collisions (e.g. USDC on
 * Solana vs USDC on Ethereum) from attaching pool-age or discovery vectors from
 * the wrong network to a held position.
 */
export function buildDiscoveryNetworkMap<T extends { network: string; symbol: string }>(
  tokens: T[],
): Map<string, T> {
  const map = new Map<string, T>();
  for (const token of tokens) {
    const key = `${token.network.toLowerCase()}:${token.symbol.toUpperCase()}`;
    // Preserve first occurrence per key (discovery results are typically sorted by liquidity desc).
    if (!map.has(key)) {
      map.set(key, token);
    }
  }
  return map;
}

/**
 * Build a map from `${network}:${address}` to a discovered token object.
 * Address-based keying is the correct join strategy for DEX discovery metadata
 * because same-symbol fakes on the same network cannot inherit metadata from the
 * canonical token.
 */
export function buildDiscoveryAddressMap<T extends { network: string; address: string }>(
  tokens: T[],
): Map<string, T> {
  const map = new Map<string, T>();
  for (const token of tokens) {
    const key = `${token.network.toLowerCase()}:${token.address.toLowerCase()}`;
    if (!map.has(key)) {
      map.set(key, token);
    }
  }
  return map;
}

export interface TrackedDexTarget {
  raw: string;
  symbol: string;
  network: string | null;
}

function parseTrackedDexSymbol(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const networkMatch = trimmed.match(/^([^:]+):(.+)$/);
  if (networkMatch) {
    return normalizeTrackedSymbol(networkMatch[2]);
  }

  return normalizeTrackedSymbol(trimmed);
}

function parseTrackedDexTarget(raw: string): TrackedDexTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const networkMatch = trimmed.match(/^([^:]+):(.+)$/);
  if (networkMatch) {
    const network = networkMatch[1]?.trim().toLowerCase() ?? '';
    const symbol = parseTrackedDexSymbol(networkMatch[2] ?? '');
    if (network && symbol) {
      return { raw: trimmed, network, symbol };
    }
  }

  const symbol = parseTrackedDexSymbol(trimmed);
  return symbol ? { raw: trimmed, network: null, symbol } : null;
}

export function normalizeTrackedSymbol(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }

  const upper = raw.toUpperCase();
  const stripped = upper
    .replace(/[:/]/g, '-')
    .replace(/-PERP$/, '')
    .replace(/USDT$/, '')
    .replace(/USD$/, '')
    .split('-')
    .find((token) => token.length > 0 && token !== 'LONG' && token !== 'SHORT');

  return stripped ?? null;
}

export function collectPerpsTrackedSymbols(sessionMetrics: RuntimeSessionMetrics): string[] {
  const symbols = new Set<string>();

  for (const position of sessionMetrics.openPositions) {
    const normalized = normalizeTrackedSymbol(position.instrumentId);
    if (normalized) {
      symbols.add(normalized);
    }
  }

  for (const bot of sessionMetrics.managedBots ?? []) {
    const normalized = normalizeTrackedSymbol(bot.symbol);
    if (normalized) {
      symbols.add(normalized);
    }
  }

  const marketSymbol = normalizeTrackedSymbol(sessionMetrics.market.symbol);
  if (marketSymbol) {
    symbols.add(marketSymbol);
  }

  return [...symbols];
}

export function collectDexTrackedSymbols(
  sessionMetrics: RuntimeSessionMetrics,
  watchlistSymbols: string[] | undefined,
): string[] {
  return collectDexTrackedTargets(sessionMetrics, watchlistSymbols).map((target) => target.symbol);
}

export function collectDexTrackedTargets(
  sessionMetrics: RuntimeSessionMetrics,
  watchlistSymbols: string[] | undefined,
): TrackedDexTarget[] {
  const targets = new Map<string, TrackedDexTarget>();

  function upsert(target: TrackedDexTarget): void {
    const key = target.network ? `${target.network}:${target.symbol}` : target.symbol;
    if (!targets.has(key)) {
      targets.set(key, target);
    }
  }

  for (const position of sessionMetrics.openPositions) {
    if (position.venueType !== 'dex') {
      continue;
    }

    const normalized = normalizeTrackedSymbol(position.instrumentId);
    if (normalized) {
      upsert({ raw: position.instrumentId, network: null, symbol: normalized });
    }
  }

  for (const symbol of watchlistSymbols ?? []) {
    const parsed = parseTrackedDexTarget(symbol);
    if (parsed) {
      upsert(parsed);
    }
  }

  return [...targets.values()];
}

function parseDexPositionIdentity(position: RuntimePositionSnapshot): TrackedDexTarget | null {
  const parsed = parseTrackedDexTarget(position.instrumentId);
  if (parsed) {
    return parsed;
  }

  const symbol = normalizeTrackedSymbol(position.instrumentId);
  return symbol ? { raw: position.instrumentId, symbol, network: null } : null;
}

export function findDexPositionForTarget(
  positions: RuntimePositionSnapshot[],
  target: TrackedDexTarget,
): RuntimePositionSnapshot | null {
  const targetKey = target.network ? `${target.network}:${target.symbol}` : target.symbol;

  for (const position of positions) {
    if (position.venueType !== 'dex') {
      continue;
    }

    const identity = parseDexPositionIdentity(position);
    if (!identity) {
      continue;
    }

    const positionKey = identity.network ? `${identity.network}:${identity.symbol}` : identity.symbol;
    if (position.instrumentId === target.raw || positionKey === targetKey) {
      return position;
    }
  }

  return null;
}
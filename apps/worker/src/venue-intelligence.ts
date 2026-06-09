import type { RuntimePositionSnapshot, RuntimeSessionMetrics } from './runtime-composition.js';

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
    const symbol = parseTrackedDexSymbol(networkMatch[2]);
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
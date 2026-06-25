import type {
  TokenInfo,
  TokenSearchCandidate,
  TokenSearchPolicyOptions,
  TokenSafetyReason,
  TokenSafetyReasonCode,
  TokenSafetySummary,
  CanonicalTokenDefinition,
  MarketDataConfig,
} from './types.js';

export interface TokenSafetyPolicyConfig {
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  minTokenAgeHours: number;
  deadPoolMinAgeHours: number;
  deadPoolMaxVolume24hUsd: number;
  preferCanonical: boolean;
  requireCanonicalForKnownSymbols: boolean;
  includeBlockedSearchResults: boolean;
  canonicalTokens: Record<string, Record<string, { address: string; name: string; aliases: string[] }>>;
}

export function resolveTokenSafetyPolicyConfig(config: MarketDataConfig): TokenSafetyPolicyConfig {
  const ts = config.tokenSafety;
  if (!ts || !ts.enabled) {
    return {
      minLiquidityUsd: 10_000,
      minVolume24hUsd: 0,
      minTokenAgeHours: 0,
      deadPoolMinAgeHours: 720,
      deadPoolMaxVolume24hUsd: 1_000,
      preferCanonical: false,
      requireCanonicalForKnownSymbols: false,
      includeBlockedSearchResults: false,
      canonicalTokens: {},
    };
  }
  return {
    minLiquidityUsd: ts.defaults.minLiquidityUsd,
    minVolume24hUsd: ts.defaults.minVolume24hUsd,
    minTokenAgeHours: ts.defaults.minTokenAgeHours,
    deadPoolMinAgeHours: ts.defaults.deadPoolMinAgeHours,
    deadPoolMaxVolume24hUsd: ts.defaults.deadPoolMaxVolume24hUsd,
    preferCanonical: ts.defaults.preferCanonical,
    requireCanonicalForKnownSymbols: ts.defaults.requireCanonicalForKnownSymbols,
    includeBlockedSearchResults: ts.defaults.includeBlockedSearchResults,
    canonicalTokens: ts.canonicalTokens,
  };
}

export function lookupCanonical(
  input: string,
  network: string,
  canonicalTokens: Record<string, Record<string, { address: string; name: string; aliases: string[] }>>,
): CanonicalTokenDefinition | undefined {
  const networkMap = canonicalTokens[network.toLowerCase()];
  if (!networkMap) return undefined;

  const upperInput = input.toUpperCase();

  // Direct match
  const entry = networkMap[upperInput];
  if (entry) {
    return { symbol: upperInput, network: network.toLowerCase(), address: entry.address, name: entry.name, aliases: entry.aliases };
  }

  // Alias match
  for (const [sym, def] of Object.entries(networkMap)) {
    if (def.aliases.some((a) => a.toUpperCase() === upperInput)) {
      return { symbol: sym, network: network.toLowerCase(), address: def.address, name: def.name, aliases: def.aliases };
    }
  }

  // Address match — supports callers that pass an on-chain address (e.g.
  // swapBaseTokenAddress from a trading binding).  EVM addresses (0x…)
  // are case-insensitive; Solana base58 addresses are case-sensitive.
  for (const [sym, def] of Object.entries(networkMap)) {
    const inputIsEvm = input.toLowerCase().startsWith('0x');
    const defIsEvm = def.address.toLowerCase().startsWith('0x');
    const addrMatch = (inputIsEvm && defIsEvm)
      ? def.address.toLowerCase() === input.toLowerCase()
      : def.address === input;
    if (addrMatch) {
      return { symbol: sym, network: network.toLowerCase(), address: def.address, name: def.name, aliases: def.aliases };
    }
  }

  return undefined;
}

export function isKnownCanonicalSymbol(
  symbol: string,
  canonicalTokens: Record<string, Record<string, { address: string; name: string; aliases: string[] }>>,
): boolean {
  const upperSymbol = symbol.toUpperCase();
  for (const networkMap of Object.values(canonicalTokens)) {
    if (networkMap[upperSymbol]) return true;
    for (const def of Object.values(networkMap)) {
      if (def.aliases.some((a) => a.toUpperCase() === upperSymbol)) return true;
    }
  }
  return false;
}

function computeAgeHours(poolCreatedAt: string | undefined): number | undefined {
  if (!poolCreatedAt) return undefined;
  const created = new Date(poolCreatedAt).getTime();
  if (Number.isNaN(created)) return undefined;
  const now = Date.now();
  return Math.max(0, (now - created) / (1000 * 60 * 60));
}

export function evaluateTokenSafety(
  token: TokenInfo & { poolCreatedAt?: string },
  policy: TokenSafetyPolicyConfig,
  options?: TokenSearchPolicyOptions,
): TokenSafetySummary {
  const blockedReasons: TokenSafetyReason[] = [];
  const warnings: TokenSafetyReason[] = [];

  const effectiveMinLiquidity = options?.minLiquidityUsd ?? policy.minLiquidityUsd;
  const effectiveMinVolume = options?.minVolume24hUsd ?? policy.minVolume24hUsd;
  const effectiveMinAge = options?.minTokenAgeHours ?? policy.minTokenAgeHours;

  // Liquidity check
  if (token.liquidityUsd < effectiveMinLiquidity) {
    blockedReasons.push({
      code: 'token.low_liquidity' as TokenSafetyReasonCode,
      message: `Liquidity $${token.liquidityUsd.toLocaleString()} below minimum $${effectiveMinLiquidity.toLocaleString()}`,
      actual: token.liquidityUsd,
      threshold: effectiveMinLiquidity,
    });
  }

  // Volume check
  if (effectiveMinVolume > 0 && token.volume24hUsd < effectiveMinVolume) {
    blockedReasons.push({
      code: 'token.low_volume' as TokenSafetyReasonCode,
      message: `24h volume $${token.volume24hUsd.toLocaleString()} below minimum $${effectiveMinVolume.toLocaleString()}`,
      actual: token.volume24hUsd,
      threshold: effectiveMinVolume,
    });
  }

  // Age check
  const ageHours = computeAgeHours((token as TokenInfo & { poolCreatedAt?: string }).poolCreatedAt);
  if (ageHours !== undefined && effectiveMinAge > 0 && ageHours < effectiveMinAge) {
    blockedReasons.push({
      code: 'token.too_new' as TokenSafetyReasonCode,
      message: `Token age ${ageHours.toFixed(1)}h below minimum ${effectiveMinAge}h`,
      actual: ageHours,
      threshold: effectiveMinAge,
    });
  }

  // Age unknown warning — signals to consumers that age could not be verified
  if (ageHours === undefined && effectiveMinAge > 0) {
    warnings.push({
      code: 'token.age_unknown' as TokenSafetyReasonCode,
      message: `Token age unknown — minimum ${effectiveMinAge}h required but creation time unavailable`,
      threshold: effectiveMinAge,
    });
  }

  // Dead pool check
  if (
    ageHours !== undefined &&
    ageHours >= policy.deadPoolMinAgeHours &&
    token.volume24hUsd <= policy.deadPoolMaxVolume24hUsd
  ) {
    blockedReasons.push({
      code: 'token.dead_pool' as TokenSafetyReasonCode,
      message: `Dead pool: age ${ageHours.toFixed(0)}h with volume $${token.volume24hUsd.toLocaleString()}`,
      actual: token.volume24hUsd,
      threshold: policy.deadPoolMaxVolume24hUsd,
    });
  }

  // Canonical check
  const canonical = lookupCanonical(token.symbol, token.network, policy.canonicalTokens);
  const isCanonical = canonical !== undefined && canonical.address.toLowerCase() === token.address.toLowerCase();

  if (
    !isCanonical &&
    policy.requireCanonicalForKnownSymbols &&
    canonical !== undefined
  ) {
    blockedReasons.push({
      code: 'token.non_canonical' as TokenSafetyReasonCode,
      message: `${token.symbol} on ${token.network} is not the canonical address`,
      actual: token.address,
      threshold: canonical?.address,
    });
  }

  const eligible = blockedReasons.length === 0;
  const score = computeSafetyScore(token, isCanonical, ageHours, policy.preferCanonical);

  return {
    eligible,
    score,
    canonical: isCanonical,
    canonicalSymbol: isCanonical ? canonical?.symbol : undefined,
    ageHours,
    blockedReasons,
    warnings,
  };
}

function computeSafetyScore(
  token: TokenInfo,
  isCanonical: boolean,
  ageHours: number | undefined,
  preferCanonical: boolean,
): number {
  let score = 0;
  // Canonical gets massive boost
  if (isCanonical && preferCanonical) score += 1_000_000_000;
  // Liquidity weight
  score += Math.min(token.liquidityUsd, 100_000_000);
  // Volume secondary
  score += Math.min(token.volume24hUsd / 10, 10_000_000);
  // Age bonus (older = more trusted, capped)
  if (ageHours !== undefined) {
    score += Math.min(ageHours * 10, 100_000);
  }
  return score;
}

export function rankAndFilterCandidates(
  tokens: (TokenInfo & { poolCreatedAt?: string })[],
  policy: TokenSafetyPolicyConfig,
  options?: TokenSearchPolicyOptions,
): TokenSearchCandidate[] {
  const includeBlocked = options?.includeBlocked ?? policy.includeBlockedSearchResults;
  const preferCanonical = options?.preferCanonical ?? policy.preferCanonical;
  const limit = options?.limit ?? 10;

  // Evaluate safety for each token
  const candidates: TokenSearchCandidate[] = tokens.map((token) => {
    const safety = evaluateTokenSafety(token, policy, options);
    return {
      ...token,
      safety: {
        ...safety,
        score: computeSafetyScore(token, safety.canonical, safety.ageHours, preferCanonical),
      },
    };
  });

  // Filter unless includeBlocked
  const filtered = includeBlocked ? candidates : candidates.filter((c) => c.safety.eligible);

  // Sort: eligible first, then by score descending
  filtered.sort((a, b) => {
    if (a.safety.eligible !== b.safety.eligible) {
      return a.safety.eligible ? -1 : 1;
    }
    return b.safety.score - a.safety.score;
  });

  return filtered.slice(0, limit);
}

export function deduplicateByAddress(tokens: TokenInfo[]): TokenInfo[] {
  const seen = new Set<string>();
  const result: TokenInfo[] = [];
  for (const token of tokens) {
    const key = `${token.network.toLowerCase()}:${token.address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(token);
  }
  return result;
}

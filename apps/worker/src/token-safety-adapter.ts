import { ok, err } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import type {
  SwapTokenSafetyPort,
  SwapTokenSafetyCheckRequest,
  SwapTokenSafetyApproval,
  SwapTokenSafetyRejection,
} from '@herobids/domain';
import {
  evaluateTokenSafety,
  resolveTokenSafetyPolicyConfig,
  type MarketDataConfig,
  type TokenInfo,
  type TokenSafetyPolicyConfig,
} from '@herobids/market-data';
import type { TokenSafetyOverrideRepository } from '@herobids/db';

export interface ResolvedSwapTokenData extends TokenInfo {
  poolCreatedAt?: string;
  ageResolution: 'available' | 'missing' | 'indeterminate';
}

export interface TokenSafetyAdapterDeps {
  marketDataConfig: MarketDataConfig;
  overrideRepo: TokenSafetyOverrideRepository;
  resolveTokenData: (network: string, tokenAddress: string) => Promise<ResolvedSwapTokenData | null>;
}

export function createSwapTokenSafetyAdapter(deps: TokenSafetyAdapterDeps): SwapTokenSafetyPort {
  const policy = resolveTokenSafetyPolicyConfig(deps.marketDataConfig);
  const tradeGuard = deps.marketDataConfig.tokenSafety?.tradeGuard;

  return {
    async checkSwapTarget(
      request: SwapTokenSafetyCheckRequest,
    ): Promise<Result<SwapTokenSafetyApproval, SwapTokenSafetyRejection>> {
      // Sell-only bypasses safety check
      if (request.swapSide === 'sell') {
        return ok({
          tokenAddress: request.tokenAddress,
          tokenSymbol: request.tokenSymbol,
          overridden: false,
        });
      }

      // If trade guard is disabled, approve all
      if (!tradeGuard?.enabled) {
        return ok({
          tokenAddress: request.tokenAddress,
          tokenSymbol: request.tokenSymbol,
          overridden: false,
        });
      }

      // Override ticket check
      if (request.overrideId) {
        const override = await deps.overrideRepo.fetchActive(
          request.overrideId,
          request.actorType,
          request.actorId,
          request.network,
          request.tokenAddress,
          request.venueAccountId,
        );

        if (override) {
          const consumed = await deps.overrideRepo.consume(request.overrideId, request.botId ?? request.actorId);
          if (consumed) {
            return ok({
              tokenAddress: request.tokenAddress,
              tokenSymbol: request.tokenSymbol,
              overridden: true,
            });
          }
        }
        // Invalid or expired override — proceed with normal check
      }

      // Resolve token data
      const tokenData = await deps.resolveTokenData(request.network, request.tokenAddress);
      if (!tokenData) {
        return err({
          code: 'token.not_found',
          message: `Token ${request.tokenSymbol ?? request.tokenAddress} on ${request.network} could not be resolved`,
          retryable: false,
        });
      }

      // Compute effective thresholds with dynamic liquidity multiplier and instance tightening
      let effectivePolicy = computeEffectivePolicy(policy, tradeGuard, request.estimatedOrderNotionalUsd);
      if (request.instanceThresholds) {
        effectivePolicy = applyInstanceThresholds(effectivePolicy, request.instanceThresholds);
      }

      const allowOverrides = tradeGuard.allowOverrides && request.instanceThresholds?.allowOverrides !== false;

      const requiresAgeData = effectivePolicy.minTokenAgeHours > 0 || effectivePolicy.deadPoolMinAgeHours > 0;
      if (requiresAgeData && !tokenData.poolCreatedAt) {
        const reasonCodes = ['token.age_unknown'];
        let overrideTicket: SwapTokenSafetyRejection['overrideTicket'] | undefined;
        if (allowOverrides) {
          const expiresAt = new Date(Date.now() + tradeGuard.overrideTtlMs);
          const issued = await deps.overrideRepo.issue({
            actorType: request.actorType,
            actorId: request.actorId,
            botId: request.botId,
            venueAccountId: request.venueAccountId,
            network: request.network,
            tokenAddress: request.tokenAddress,
            reasonCodes,
            expiresAt,
          });
          overrideTicket = {
            id: issued.id,
            expiresAt: expiresAt.toISOString(),
            tokenAddress: request.tokenAddress,
            network: request.network,
            reasonCodes,
          };
        }

        return err({
          code: 'token.safety_rejected',
          message: `Token age could not be resolved for ${request.tokenSymbol ?? request.tokenAddress} on ${request.network}`,
          retryable: allowOverrides,
          details: {
            liquidityUsd: tokenData.liquidityUsd,
            volume24hUsd: tokenData.volume24hUsd,
            reasonCodes,
          },
          overrideTicket,
        });
      }

      // Evaluate safety
      const safety = evaluateTokenSafety(tokenData, effectivePolicy);

      if (safety.eligible) {
        return ok({
          tokenAddress: request.tokenAddress,
          tokenSymbol: request.tokenSymbol,
          overridden: false,
          liquidityUsd: tokenData.liquidityUsd,
          volume24hUsd: tokenData.volume24hUsd,
          ageHours: safety.ageHours,
        });
      }

      // Rejection — optionally issue override ticket
      const reasonCodes = safety.blockedReasons.map((r) => r.code);
      const message = safety.blockedReasons.map((r) => r.message).join('; ');

      let overrideTicket: SwapTokenSafetyRejection['overrideTicket'] | undefined;
      if (allowOverrides) {
        const expiresAt = new Date(Date.now() + tradeGuard.overrideTtlMs);
        const issued = await deps.overrideRepo.issue({
          actorType: request.actorType,
          actorId: request.actorId,
          botId: request.botId,
          venueAccountId: request.venueAccountId,
          network: request.network,
          tokenAddress: request.tokenAddress,
          reasonCodes,
          expiresAt,
        });
        overrideTicket = {
          id: issued.id,
          expiresAt: expiresAt.toISOString(),
          tokenAddress: request.tokenAddress,
          network: request.network,
          reasonCodes,
        };
      }

      return err({
        code: 'token.safety_rejected',
        message,
        retryable: allowOverrides,
        details: {
          liquidityUsd: tokenData.liquidityUsd,
          volume24hUsd: tokenData.volume24hUsd,
          ageHours: safety.ageHours,
          reasonCodes,
        },
        overrideTicket,
      });
    },
  };
}

function computeEffectivePolicy(
  basePolicy: TokenSafetyPolicyConfig,
  tradeGuard: { liquidityMultiplier: number },
  estimatedOrderNotionalUsd?: string,
): TokenSafetyPolicyConfig {
  if (!estimatedOrderNotionalUsd) return basePolicy;

  const notional = Number(estimatedOrderNotionalUsd);
  if (!Number.isFinite(notional) || notional <= 0) return basePolicy;

  const dynamicMinLiquidity = notional * tradeGuard.liquidityMultiplier;
  const effectiveMinLiquidity = Math.max(basePolicy.minLiquidityUsd, dynamicMinLiquidity);

  return {
    ...basePolicy,
    minLiquidityUsd: effectiveMinLiquidity,
  };
}

function applyInstanceThresholds(
  policy: TokenSafetyPolicyConfig,
  thresholds: { minLiquidityUsd?: number; minVolume24hUsd?: number; minAgeHours?: number },
): TokenSafetyPolicyConfig {
  return {
    ...policy,
    minLiquidityUsd: Math.max(policy.minLiquidityUsd, thresholds.minLiquidityUsd ?? 0),
    minVolume24hUsd: Math.max(policy.minVolume24hUsd, thresholds.minVolume24hUsd ?? 0),
    minTokenAgeHours: Math.max(policy.minTokenAgeHours, thresholds.minAgeHours ?? 0),
  };
}

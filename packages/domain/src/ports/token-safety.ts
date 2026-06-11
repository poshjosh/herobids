import type { Result } from '../result.js';

export interface SwapTokenSafetyCheckRequest {
  actorType: string;
  actorId: string;
  botId?: string;
  venue: string;
  venueAccountId: string;
  network: string;
  tokenAddress: string;
  tokenSymbol?: string;
  swapSide: 'buy' | 'sell';
  estimatedOrderNotionalUsd?: string;
  overrideId?: string;
  /** Instance-level thresholds that tighten operator defaults (higher = stricter) */
  instanceThresholds?: {
    minLiquidityUsd?: number;
    minVolume24hUsd?: number;
    minAgeHours?: number;
    allowOverrides?: boolean;
  };
}

export interface SwapTokenSafetyApproval {
  tokenAddress: string;
  tokenSymbol?: string;
  overridden: boolean;
  liquidityUsd?: number;
  volume24hUsd?: number;
  ageHours?: number;
}

export interface SwapTokenSafetyOverrideTicket {
  id: string;
  expiresAt: string;
  tokenAddress: string;
  network: string;
  reasonCodes: string[];
}

export interface SwapTokenSafetyRejection {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  overrideTicket?: SwapTokenSafetyOverrideTicket;
}

export interface SwapTokenSafetyPort {
  checkSwapTarget(
    request: SwapTokenSafetyCheckRequest,
  ): Promise<Result<SwapTokenSafetyApproval, SwapTokenSafetyRejection>>;
}

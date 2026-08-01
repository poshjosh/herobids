import type { BlueprintKind } from '../blueprint.js';

export interface BlueprintExecutionCapabilityProfile {
  provider: string;
  venueType: 'orderbook' | 'swap' | null;
  supportedActorKinds: Array<'agent' | 'bot'>;
  supportedExecutionModes: Array<'paper' | 'shadow' | 'live'>;
  bindingRequirements: Record<string, { min: number; max: number }>;
  supportedNetworks: string[];
  symbolConstraints: string[] | null;
  assetConstraints: Array<{ base: string; quote: string }> | null;
}

export interface BlueprintExecutionCapabilityInput {
  kind: BlueprintKind;
  tradingCapable: boolean;
  executionDefaults: { mode: string; slippageBps: number } | null;
  venue: string | null;
  venueType: 'orderbook' | 'swap' | null;
  swapAssets: {
    baseAsset: string;
    quoteAsset: string;
    baseDecimals: number;
    quoteDecimals: number;
  } | null;
  requestedMode: 'paper' | 'shadow' | 'live' | null;
  liveOptIn: boolean;
  binding: {
    kind: 'agent';
    connectionIds: string[];
  } | {
    kind: 'bot';
    connectionId: string;
    venueAccountId: string;
  } | null;
}

export interface BlueprintExecutionCapabilityResult {
  resolvedMode: 'paper' | 'shadow' | 'live' | null;
  errors: string[];
  warnings: string[];
  resolvedBindings: Array<{ connectionId: string; venueAccountId?: string }>;
}

export interface BlueprintExecutionCapabilityResolver {
  resolve(
    input: BlueprintExecutionCapabilityInput,
  ): Promise<BlueprintExecutionCapabilityResult>;
  getCapabilityProfile(
    provider: string,
    venue: string,
  ): BlueprintExecutionCapabilityProfile | null;
}

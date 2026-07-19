import type { Result } from '../result.js';
import type { MarketAssessmentIdentity } from '../market-assessment.js';

/** Parameters for resolving a canonical assessment identity at the worker boundary. */
export interface ResolveIdentityParams {
  agentId: string;
  symbol: string;
  /** If not provided, resolved from agent binding. */
  venueFamily?: string;
  /** If not provided, inferred from agent binding. */
  instrumentKind?: 'orderbook' | 'perp' | 'swap' | 'dex';
  /** If not provided, resolved from agent's active preset binding. */
  styleTier?: 'economy' | 'standard' | 'premium';
}

/** Adapter at the worker boundary that wraps venue-specific normalization/validation, DEX token resolution, and style tier resolution. */
export interface AssessmentIdentityResolver {
  /**
   * Resolve a raw user-provided symbol into a canonical MarketAssessmentIdentity.
   * Handles venue normalization, DEX token resolution, known-symbol validation,
   * and style tier inference from authoritative preset binding.
   *
   * Returns an error (not success) for unresolvable/ambiguous identities — no billing occurs.
   */
  resolveIdentity(params: ResolveIdentityParams): Promise<Result<MarketAssessmentIdentity>>;
}

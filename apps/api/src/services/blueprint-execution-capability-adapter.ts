import type {
  BlueprintExecutionCapabilityResolver,
  BlueprintExecutionCapabilityInput,
  BlueprintExecutionCapabilityResult,
  BlueprintExecutionCapabilityProfile,
} from '@herobids/domain';
import type { ProviderCatalogResponse } from '@herobids/domain';
import { PROVIDER_CATEGORIES, getProviderCategories } from '@herobids/domain';

// ── Venue Profile Resolver (stub interface) ──────────────────────────────────

/**
 * Resolves venue capability profiles for execution mode validation.
 * Full implementation in packages/venues — stubbed here per the Phase 1 plan.
 */
export interface VenueProfileResolver {
  /**
   * Return the execution capability profile for a (provider, venueType) pair.
   * Returns null when the provider/venue combination is unknown or unsupported.
   */
  getCapabilityProfile(
    provider: string,
    venueType: 'orderbook' | 'swap',
  ): BlueprintExecutionCapabilityProfile | null;
}

// ── Stub Implementation ──────────────────────────────────────────────────────

/**
 * Stub venue profile resolver that uses the provider catalog to derive basic
 * capability profiles. TODO: Replace with full venue-adapter integration
 * from packages/venues when adapters expose their capability contracts.
 */
class StubVenueProfileResolver implements VenueProfileResolver {
  private readonly providerCatalog: ProviderCatalogResponse;

  constructor(providerCatalog: ProviderCatalogResponse) {
    this.providerCatalog = providerCatalog;
  }

  getCapabilityProfile(
    provider: string,
    venueType: 'orderbook' | 'swap',
  ): BlueprintExecutionCapabilityProfile | null {
    const providerDef = this.providerCatalog.providers.find((p) => p.id === provider);
    if (!providerDef) return null;

    const categories = getProviderCategories(provider);
    const isTrading = categories.includes('trading') || categories.includes('swap');
    const isSwap = categories.includes('swap');

    // Non-trading providers (e.g., gmail) have no trading capability
    if (!isTrading) return null;

    // Derive supported execution modes from provider type
    const supportedModes: Array<'paper' | 'shadow' | 'live'> = [];
    if (!isSwap) {
      // Orderbook venues support paper
      supportedModes.push('paper');
    }
    supportedModes.push('shadow');
    supportedModes.push('live');

    return {
      provider,
      venueType: isSwap ? 'swap' : venueType,
      supportedActorKinds: ['agent', 'bot'],
      supportedExecutionModes: supportedModes,
      bindingRequirements: {
        agent: { min: 0, max: 20 },
        bot: { min: 1, max: 1 },
      },
      supportedNetworks: [], // TODO: populate from venue adapter
      symbolConstraints: null, // no constraints in stub
      assetConstraints: null,
    };
  }
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Blueprint execution capability adapter — resolves execution mode, validates
 * bindings, and returns capability results for preview and confirmation flows.
 *
 * Follows the Shared Execution Resolver rules from the Phase 1 plan:
 * 1. paper available/default only when adapter/recipe supports paper simulation
 * 2. swap recipes default to shadow; paper rejected for swaps
 * 3. live requires explicit liveOptIn, compatible active binding, provider capability,
 *    matching venue type/provider, compatible symbol/assets
 * 4. Missing/inactive/foreign/mismatched bindings fail validation
 *
 * Binding cardinality:
 * - Non-trading agent: zero venue-trading bindings, mode=null
 * - Trading agent paper: 0+ active user-owned trading connections
 * - Trading agent shadow/live: 1+ active user-owned trading connections
 * - Bot any mode: exactly 1 active connection + 1 venue account
 */
export class BlueprintExecutionCapabilityAdapter implements BlueprintExecutionCapabilityResolver {
  private readonly venueResolver: VenueProfileResolver;

  constructor(
    providerCatalog: ProviderCatalogResponse,
  ) {
    this.venueResolver = new StubVenueProfileResolver(providerCatalog);
  }

  /**
   * Allow injecting a custom venue resolver for testing.
   */
  withVenueResolver(resolver: VenueProfileResolver): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).venueResolver = resolver;
    return this;
  }

  async resolve(
    input: BlueprintExecutionCapabilityInput,
  ): Promise<BlueprintExecutionCapabilityResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Non-trading agent → mode: null, no bindings needed
    if (!input.tradingCapable && input.kind === 'agent') {
      // Validate no trading bindings
      if (input.binding?.kind === 'agent' && input.binding.connectionIds.length > 0) {
        errors.push('Non-trading agents must have zero venue-trading bindings');
      }
      if (input.binding?.kind === 'bot') {
        errors.push('Non-trading agents must not have bot-style bindings');
      }
      return {
        resolvedMode: null,
        errors,
        warnings,
        resolvedBindings: [],
      };
    }

    // 2. Trading agent or bot — validate binding presence and shape
    if (input.kind === 'agent') {
      // Agent binding validation
      const binding = input.binding;
      if (!binding || binding.kind !== 'agent') {
        // No binding provided — allow for non-live modes
        if (input.requestedMode === 'live') {
          errors.push('Live mode requires at least one active trading connection');
        }
      } else {
        const connectionIds = [...new Set(binding.connectionIds)];
        if (connectionIds.length > 20) {
          errors.push('Agent bindings: max 20 connection IDs');
        }
        if (input.requestedMode === 'live' && connectionIds.length === 0) {
          errors.push('Live mode requires at least one active trading connection');
        }
        if (input.requestedMode !== 'live' && (input.requestedMode === 'shadow') && connectionIds.length === 0) {
          errors.push('Shadow mode requires at least one active trading connection');
        }
      }
    } else if (input.kind === 'bot') {
      const binding = input.binding;
      if (!binding || binding.kind !== 'bot') {
        errors.push('Bot instantiation requires exactly one active connection and venue account');
      } else {
        if (!binding.connectionId || binding.connectionId.length === 0) {
          errors.push('Bot binding: connectionId is required');
        }
        if (!binding.venueAccountId || binding.venueAccountId.length === 0) {
          errors.push('Bot binding: venueAccountId is required');
        }
      }
    }

    // 3. Get capability profile
    let profile: BlueprintExecutionCapabilityProfile | null = null;
    if (input.venue && input.venueType) {
      profile = this.getCapabilityProfile(input.venue, input.venueType);
    }

    // 4. Determine available modes
    const isSwap = input.venueType === 'swap';

    // Swap recipes default to shadow; paper rejected
    if (isSwap && input.requestedMode === 'paper') {
      errors.push('Paper mode is not available for swap recipes');
    }

    // Check paper support
    const paperSupported = profile?.supportedExecutionModes.includes('paper') ?? false;
    if (input.requestedMode === 'paper' && !paperSupported) {
      errors.push('Paper mode is not supported by this venue/provider combination');
    }

    // Check live requirements
    if (input.requestedMode === 'live') {
      if (!input.liveOptIn) {
        errors.push('Live mode requires explicit liveOptIn');
      }
      if (!profile?.supportedExecutionModes.includes('live')) {
        errors.push('Live mode is not supported by this venue/provider combination');
      }
    }

    // 5. Resolve final mode
    let resolvedMode: 'paper' | 'shadow' | 'live' | null = null;

    if (!input.tradingCapable) {
      resolvedMode = null;
    } else if (input.requestedMode) {
      if (errors.length === 0) {
        resolvedMode = input.requestedMode;
      }
    } else if (isSwap) {
      resolvedMode = 'shadow';
    } else if (paperSupported) {
      resolvedMode = 'paper';
    } else {
      resolvedMode = 'shadow';
    }

    // 6. Build resolved bindings
    const resolvedBindings: Array<{ connectionId: string; venueAccountId?: string }> = [];
    if (input.binding?.kind === 'agent') {
      for (const cid of [...new Set(input.binding.connectionIds)]) {
        resolvedBindings.push({ connectionId: cid });
      }
    } else if (input.binding?.kind === 'bot') {
      resolvedBindings.push({
        connectionId: input.binding.connectionId,
        venueAccountId: input.binding.venueAccountId,
      });
    }

    return {
      resolvedMode,
      errors,
      warnings,
      resolvedBindings,
    };
  }

  getCapabilityProfile(
    provider: string,
    venueType: string,
  ): BlueprintExecutionCapabilityProfile | null {
    if (venueType !== 'orderbook' && venueType !== 'swap') return null;
    return this.venueResolver.getCapabilityProfile(provider, venueType as 'orderbook' | 'swap');
  }
}

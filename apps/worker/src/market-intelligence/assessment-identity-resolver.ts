import type { Database } from '@herobids/db';
import { agents, bots, venueAccounts, agentPresetBindings } from '@herobids/db';
import { eq, and } from 'drizzle-orm';
import type {
  AssessmentIdentityResolver,
  ResolveIdentityParams,
  MarketAssessmentIdentity,
} from '@herobids/domain';
import { resolveAssessmentIdentity, err, type Result } from '@herobids/domain';
import type { VenueInstrumentCache } from '../venue-instrument-cache.js';
import { createLogger } from '../logger.js';

const logger = createLogger('assessment-identity-resolver');

export interface AssessmentIdentityResolverDeps {
  db: Database;
  instrumentCache: VenueInstrumentCache;
  /** Resolve a swap/dex token to { network, address }. Returns null if unresolved. */
  resolveToken?: (symbol: string, network?: string) => Promise<{ network: string; address: string } | null>;
}

/**
 * Resolves market assessment identity from agent bindings, venue profiles,
 * and token resolution.
 *
 * Resolution strategy:
 * 1. Venue family and instrument kind: resolved from agent's bot binding
 *    (via venue account profile), fallback to agent's unifiedConfig.technical.filters,
 *    or explicit caller-provided values.
 * 2. Style tier: resolved from active preset binding (agent_preset_bindings),
 *    or explicit caller-provided value.
 * 3. Symbol validation: orderbook/perp uses VenueInstrumentCache (fail-closed);
 *    swap/dex uses token resolver (resolveToken dep).
 * 4. Delegates final identity assembly to domain-level resolveAssessmentIdentity.
 */
export class AssessmentIdentityResolverImpl implements AssessmentIdentityResolver {
  constructor(private readonly deps: AssessmentIdentityResolverDeps) {}

  async resolveIdentity(params: ResolveIdentityParams): Promise<Result<MarketAssessmentIdentity>> {
    const { agentId, venueFamily: explicitVenue, instrumentKind: explicitKind, styleTier: explicitTier } = params;
    const symbol = params.symbol.trim();
    if (symbol.length === 0) {
      return err({
        code: 'assessment.identity.invalid_symbol',
        message: 'Symbol must not be empty',
      });
    }

    // ── 1. Resolve venue family and instrument kind from agent binding ──
    let venueFamily = explicitVenue;
    let instrumentKind = explicitKind;

    if (!venueFamily || !instrumentKind) {
      const binding = await this.resolveAgentBinding(agentId);
      if (!binding) {
        return err({
          code: 'assessment.identity.no_binding',
          message: `Agent ${agentId} has no venue binding. Provide explicit venueFamily and instrumentKind.`,
        });
      }
      venueFamily = venueFamily ?? binding.venueFamily;
      instrumentKind = instrumentKind ?? binding.instrumentKind;
    }

    if (!venueFamily) {
      return err({
        code: 'assessment.identity.missing_venue',
        message: 'venueFamily is required and could not be resolved from agent binding.',
      });
    }
    if (!instrumentKind) {
      return err({
        code: 'assessment.identity.missing_instrument_kind',
        message: 'instrumentKind is required and could not be resolved from agent binding.',
      });
    }

    // ── 2. Resolve style tier from active preset binding ──
    let styleTier = explicitTier;
    if (!styleTier) {
      styleTier = await this.resolveStyleTier(agentId);
      if (!styleTier) {
        return err({
          code: 'assessment.identity.no_style_tier',
          message: `Agent ${agentId} has no active preset binding. Provide explicit styleTier.`,
        });
      }
    }

    // ── 3. Resolve known symbols / token resolutions based on instrument kind ──
    let knownSymbols: Set<string> | undefined;
    let tokenResolutions: Map<string, { network: string; address: string }> | undefined;

    if (instrumentKind === 'orderbook' || instrumentKind === 'perp') {
      // Use VenueInstrumentCache — FAIL-CLOSED for billable requests
      const venueReady = this.deps.instrumentCache.isVenueReady(venueFamily);
      if (!venueReady) {
        return err({
          code: 'assessment.identity.venue_not_ready',
          message: `Venue "${venueFamily}" instrument cache is not ready or degraded. Cannot validate symbols.`,
        });
      }
      knownSymbols = this.deps.instrumentCache.getKnownSymbols(venueFamily) ?? undefined;
    } else if (instrumentKind === 'swap' || instrumentKind === 'dex') {
      // Use token resolver for DEX token resolution
      if (!this.deps.resolveToken) {
        return err({
          code: 'assessment.identity.token_resolver_not_configured',
          message: 'Token resolver is not configured. Cannot resolve swap/dex symbols.',
        });
      }
      const resolved = await this.deps.resolveToken(symbol);
      if (resolved) {
        tokenResolutions = new Map([[symbol, resolved]]);
      }
      if (!tokenResolutions || tokenResolutions.size === 0) {
        return err({
          code: 'assessment.identity.no_token_resolutions',
          message: `No token resolution data available for venue family "${venueFamily}"`,
        });
      }
    }

    // ── 4. Delegate to the domain-level identity resolver ──
    const result = resolveAssessmentIdentity({
      instrumentKind: instrumentKind as 'orderbook' | 'perp' | 'swap' | 'dex',
      venueFamily,
      styleTier,
      symbol,
      knownSymbols,
      tokenResolutions,
    });

    if (!result.ok) {
      logger.warn({ agentId, symbol, error: result.error }, 'Identity resolution failed');
    }

    return result;
  }

  // ── Private helpers ──

  private async resolveAgentBinding(agentId: string): Promise<{
    venueFamily: string;
    instrumentKind: 'orderbook' | 'perp' | 'swap' | 'dex';
  } | null> {
    // Try to resolve from bot bindings first (most common path)
    const [bot] = await this.deps.db
      .select({ venueAccountId: bots.venueAccountId })
      .from(bots)
      .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, agentId)))
      .limit(1);

    if (bot?.venueAccountId) {
      const [va] = await this.deps.db
        .select({ venueFamily: venueAccounts.venue, venueProfile: venueAccounts.venueProfile })
        .from(venueAccounts)
        .where(eq(venueAccounts.id, bot.venueAccountId))
        .limit(1);

      if (va) {
        if (!va.venueProfile) return null; // Cannot infer instrument kind without profile
        if (va.venueFamily) {
          return {
            venueFamily: va.venueFamily,
            instrumentKind: this.inferInstrumentKind(va.venueProfile.venueType),
          };
        }
      }
    }

    // Fall back to agent's own unifiedConfig.technical.filters
    const [agentRow] = await this.deps.db
      .select({ unifiedConfig: agents.unifiedConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (agentRow?.unifiedConfig?.technical?.filters?.venue) {
      return {
        venueFamily: agentRow.unifiedConfig.technical.filters.venue,
        instrumentKind: this.inferInstrumentKind(
          agentRow.unifiedConfig.technical.filters.venueType,
        ),
      };
    }

    return null;
  }

  /**
   * Best-effort inference of instrument kind from a venue type string.
   * Explicit user-provided instrumentKind always takes precedence —
   * this is only used when resolving from agent bindings.
   */
  private inferInstrumentKind(venueType?: string): 'orderbook' | 'perp' | 'swap' | 'dex' {
    switch (venueType) {
      case 'perp':
        return 'perp';
      case 'swap':
      case 'dex':
        return 'swap';
      default:
        return 'orderbook';
    }
  }

  private async resolveStyleTier(
    agentId: string,
  ): Promise<'economy' | 'standard' | 'premium' | null> {
    // Primary path: query agent_preset_bindings for the active default binding
    const [binding] = await this.deps.db
      .select({ styleTier: agentPresetBindings.styleTier })
      .from(agentPresetBindings)
      .where(
        and(
          eq(agentPresetBindings.agentId, agentId),
          eq(agentPresetBindings.scope, 'default'),
          eq(agentPresetBindings.status, 'active'),
        ),
      )
      .limit(1);

    if (binding?.styleTier) {
      return binding.styleTier as 'economy' | 'standard' | 'premium';
    }

    // No active default binding → caller must provide explicit styleTier
    return null;
  }
}

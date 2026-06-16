import type { Strategy, MarketSnapshot, StrategyError, Decision, Result } from '@herobids/domain';
import { ok, err, HybridParamsSchema } from '@herobids/domain';
import type { MechanicalStrategy } from './mechanical-strategy.js';
import type { LlmStrategy } from './llm.js';

/**
 * HybridStrategy composes MechanicalStrategy (pre-check) + LlmStrategy (final judgment).
 *
 * - If mechanicals return null (no signal) → return null immediately, no LLM call
 * - If mechanicals return go_flat or go_short → propagate immediately, no LLM call
 * - If mechanicals return an error → propagate the error, no LLM call
 * - If mechanicals return go_long → inject indicator data into snapshot context, then call LLM
 */
export class HybridStrategy implements Strategy {
  readonly id = 'hybrid-v1';
  readonly name = 'Hybrid Strategy';

  constructor(
    private readonly mechanical: MechanicalStrategy,
    private readonly llm: LlmStrategy,
  ) {}

  async evaluate(
    snapshot: MarketSnapshot,
    config: Record<string, unknown>,
  ): Promise<Result<Decision | null, StrategyError>> {
    // 1. Validate hybrid config
    const parseResult = HybridParamsSchema.safeParse(config);
    if (!parseResult.success) {
      return err({ code: 'strategy.config_invalid', message: parseResult.error.issues.map(i => i.message).join('; ') });
    }
    const hybridParams = parseResult.data;

    // 2. Run mechanical pre-check with mechanical sub-config
    const mechanicalResult = await this.mechanical.evaluate(snapshot, hybridParams.mechanical);

    // Propagate errors from mechanical stage
    if (!mechanicalResult.ok) {
      return mechanicalResult;
    }

    const mechanicalDecision = mechanicalResult.data;

    // No signal → skip LLM entirely
    if (mechanicalDecision === null) {
      return ok(null);
    }

    // Exit or short signal → propagate immediately, LLM is not needed
    if (mechanicalDecision.intent !== 'go_long') {
      return ok(mechanicalDecision);
    }

    // go_long: enrich snapshot with mechanical indicator data, then let LLM make the final call
    const enrichedSnapshot: MarketSnapshot = {
      ...snapshot,
      data: {
        ...snapshot.data,
        mechanical_confidence: mechanicalDecision.metadata?.['confidence'],
        mechanical_reasons: mechanicalDecision.metadata?.['reasons'],
        mechanical_indicators: mechanicalDecision.metadata?.['indicators'],
      },
    };

    // 4. Map hybrid params to LLM config format — prefer heavyModel for the conviction call
    const llmConfig = {
      ...hybridParams,
      model: hybridParams.heavyModel ?? hybridParams.lightModel,
    };

    return this.llm.evaluate(enrichedSnapshot, llmConfig);
  }
}

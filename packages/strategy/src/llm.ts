import type { Strategy, MarketSnapshot, StrategyError, Decision, DecisionId, VenueAccountId, InstrumentId } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok, err, quantity } from '@herobids/domain';
import { callLlmProvider } from './llm-provider.js';
import type { LlmProviderConfig, LlmResponse } from './llm-provider.js';
import { stripEmptyValues, type OpenRouterProviderControls } from '@herobids/llm';
import crypto from 'node:crypto';

/**
 * LLM strategy config — validated at schema boundary (LlmParamsSchema).
 */
export interface LlmStrategyConfig {
  provider: string;
  model: string;
  promptVersion?: string;
  maxTokens: number;
  timeoutMs: number;
  instrumentId?: string;
  positionSize?: string;
  baseUrl?: string;
}

/**
 * Parsed decision from LLM response.
 */
interface ParsedLlmDecision {
  intent: 'go_long' | 'go_short' | 'go_flat' | 'hold';
  confidence?: number;
  reasoning?: string;
}

/**
 * Artifact emitted for every LLM call (success or failure).
 * Callers can persist these for audit/replay.
 */
export interface LlmDecisionArtifact {
  decisionId: string;
  contextHash: string;
  context: Record<string, unknown>;
  promptPayload: string;
  promptVersion: string;
  rawResponse: string | null;
  parsedDecision: ParsedLlmDecision | null;
  parseStatus: 'success' | 'parse_error' | 'provider_error';
  parseError?: string;
  provider: string;
  model: string;
  tokensUsed: number;
  latencyMs: number;
  cached: boolean;
}

export type ArtifactCallback = (artifact: LlmDecisionArtifact) => Promise<void>;

const DEFAULT_PROMPT_VERSION = 'v1';
const MAX_CACHE_SIZE = 1000;
const responseCache = new Map<string, LlmResponse>();

export function clearLlmResponseCache(): void {
  responseCache.clear();
}

/**
 * LLM-based trading strategy.
 * Sends market context to an LLM and parses a structured trading decision.
 */
export class LlmStrategy implements Strategy {
  readonly id = 'llm-v1';
  readonly name = 'LLM Strategy';

  constructor(
    private readonly idGen: () => string,
    private readonly onArtifact?: ArtifactCallback,
    private readonly openRouterProviderControls?: OpenRouterProviderControls,
  ) {}

  async evaluate(
    snapshot: MarketSnapshot,
    rawConfig: Record<string, unknown>,
  ): Promise<Result<Decision | null, StrategyError>> {
    let config: LlmStrategyConfig;
    try {
      config = this.parseConfig(rawConfig);
    } catch (parseErr) {
      return err({
        code: 'strategy.config_invalid',
        message: parseErr instanceof Error ? parseErr.message : 'Invalid LLM strategy config',
      });
    }
    const contextHash = this.computeContextHash(snapshot, config);
    const decisionId = this.idGen();
    const prompt = this.buildPrompt(snapshot, config);
    const cacheKey = `${config.provider}:${config.model}:${config.promptVersion ?? DEFAULT_PROMPT_VERSION}:${config.baseUrl ?? ''}:${contextHash}`;

    const providerConfig: LlmProviderConfig = {
      provider: config.provider,
      model: config.model,
      maxTokens: config.maxTokens,
      timeoutMs: config.timeoutMs,
      baseUrl: config.baseUrl,
      openRouterProviderControls: this.openRouterProviderControls,
    };

    let llmResponse = responseCache.get(cacheKey);

    if (!llmResponse) {
      const result = await callLlmProvider(providerConfig, {
        messages: [
          { role: 'system', content: 'You are a quantitative trading assistant. Respond with JSON only.' },
          { role: 'user', content: prompt },
        ],
        maxTokens: config.maxTokens,
      });

      if (!result.ok) {
        // Emit artifact for provider error
        await this.emitArtifact({
          decisionId,
          contextHash,
          context: { snapshot: { symbol: snapshot.symbol, price: snapshot.price.toString(), timestamp: snapshot.timestamp, data: snapshot.data } },
          promptPayload: prompt,
          promptVersion: config.promptVersion ?? DEFAULT_PROMPT_VERSION,
          rawResponse: null,
          parsedDecision: null,
          parseStatus: 'provider_error',
          parseError: result.error.message,
          provider: config.provider,
          model: config.model,
          tokensUsed: 0,
          latencyMs: 0,
          cached: false,
        });

        return err({ code: 'strategy.llm_provider_error', message: result.error.message });
      }

      llmResponse = { ...result.data, cached: false };
      if (responseCache.size >= MAX_CACHE_SIZE) {
        // Evict oldest entry (first inserted key)
        const firstKey = responseCache.keys().next().value;
        if (firstKey !== undefined) responseCache.delete(firstKey);
      }
      responseCache.set(cacheKey, llmResponse);
    } else {
      llmResponse = { ...llmResponse, cached: true, latencyMs: 0 };
    }

    const parsed = this.parseResponse(llmResponse.content);

    // Emit artifact
    await this.emitArtifact({
      decisionId,
      contextHash,
      context: { snapshot: { symbol: snapshot.symbol, price: snapshot.price.toString(), timestamp: snapshot.timestamp, data: snapshot.data } },
      promptPayload: prompt,
      promptVersion: config.promptVersion ?? DEFAULT_PROMPT_VERSION,
      rawResponse: llmResponse.content,
      parsedDecision: parsed.ok ? parsed.data : null,
      parseStatus: parsed.ok ? 'success' : 'parse_error',
      parseError: parsed.ok ? undefined : parsed.error,
      provider: llmResponse.provider,
      model: llmResponse.model,
      tokensUsed: llmResponse.tokensUsed,
      latencyMs: llmResponse.latencyMs,
      cached: llmResponse.cached,
    });

    if (!parsed.ok) {
      return err({ code: 'strategy.llm_parse_error', message: parsed.error });
    }

    // "hold" means no decision
    if (parsed.data.intent === 'hold') {
      return ok(null);
    }

    const decision: Decision = {
      id: decisionId as DecisionId,
      venueAccountId: '' as VenueAccountId, // caller stamps this
      actorType: 'system',
      actorId: 'llm-strategy',
      instrumentId: (config.instrumentId ?? snapshot.symbol) as InstrumentId,
      intent: parsed.data.intent,
      targetSize: quantity(config.positionSize ?? '1'),
      timestamp: snapshot.timestamp,
      contextHash,
      metadata: {
        llmProvider: llmResponse.provider,
        llmModel: llmResponse.model,
        confidence: parsed.data.confidence,
        reasoning: parsed.data.reasoning,
      },
    };

    return ok(decision);
  }

  private parseConfig(raw: Record<string, unknown>): LlmStrategyConfig {
    const provider = raw['provider'];
    const model = raw['model'];
    if (typeof provider !== 'string' || !provider) {
      throw new Error('LLM strategy is missing required "provider" in strategy.params');
    }
    if (typeof model !== 'string' || !model) {
      throw new Error('LLM strategy is missing required "model" in strategy.params');
    }
    return {
      provider,
      model,
      promptVersion: raw['promptVersion'] as string | undefined,
      maxTokens: (raw['maxTokens'] as number) ?? 1024,
      timeoutMs: (raw['timeoutMs'] as number) ?? 30_000,
      instrumentId: raw['instrumentId'] as string | undefined,
      positionSize: raw['positionSize'] as string | undefined,
      baseUrl: raw['baseUrl'] as string | undefined,
    };
  }

  private buildPrompt(snapshot: MarketSnapshot, _config: LlmStrategyConfig): string {
    return [
      `Analyze the following market data and provide a trading decision.`,
      ``,
      `Symbol: ${snapshot.symbol}`,
      `Current Price: ${snapshot.price.toString()}`,
      `Timestamp: ${snapshot.timestamp}`,
      snapshot.data ? `Additional Data: ${JSON.stringify(snapshot.data)}` : '',
      ``,
      `Respond with a JSON object containing:`,
      `- "intent": one of "go_long", "go_short", "go_flat", "hold"`,
      `- "confidence": a number between 0 and 1`,
      `- "reasoning": a brief explanation, max 80 characters`,
      ``,
      `Example: {"intent": "go_long", "confidence": 0.8, "reasoning": "Upward momentum detected"}`,
    ].filter(Boolean).join('\n');
  }

  private parseResponse(content: string): { ok: true; data: ParsedLlmDecision } | { ok: false; error: string } {
    try {
      // Try to extract JSON from the response (may be wrapped in markdown code blocks)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { ok: false, error: 'No JSON object found in LLM response' };
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const cleaned = stripEmptyValues(parsed);
      const intent = cleaned['intent'] as string;

      if (!['go_long', 'go_short', 'go_flat', 'hold'].includes(intent)) {
        return { ok: false, error: `Invalid intent "${intent}" — expected go_long, go_short, go_flat, or hold` };
      }

      return {
        ok: true,
        data: {
          intent: intent as ParsedLlmDecision['intent'],
          confidence: typeof cleaned['confidence'] === 'number' ? cleaned['confidence'] : undefined,
          reasoning: typeof cleaned['reasoning'] === 'string' && cleaned['reasoning'].length > 0
            ? cleaned['reasoning'].slice(0, 80)
            : undefined,
        },
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `JSON parse failed: ${error}` };
    }
  }

  private computeContextHash(snapshot: MarketSnapshot, config: LlmStrategyConfig): string {
    const contextStr = JSON.stringify({
      symbol: snapshot.symbol,
      price: snapshot.price.toString(),
      timestamp: snapshot.timestamp,
      data: snapshot.data,
      model: config.model,
      promptVersion: config.promptVersion ?? DEFAULT_PROMPT_VERSION,
    });
    return crypto.createHash('sha256').update(contextStr).digest('hex').slice(0, 16);
  }

  private async emitArtifact(artifact: LlmDecisionArtifact): Promise<void> {
    if (this.onArtifact) {
      try {
        await this.onArtifact(artifact);
      } catch {
        // Artifact persistence is best-effort — never let it break strategy evaluation
      }
    }
  }
}

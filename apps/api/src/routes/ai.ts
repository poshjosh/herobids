import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { users } from '@herobids/db';
import { callLlmProvider } from '@herobids/llm';
import type { AppConfig } from '@herobids/domain';

type LlmConfig = AppConfig['llm'];

// --- Schemas ---

const GenerateConfigSchema = z.object({
  text: z.string().min(1).max(4000),
});

const AnalyzePortfolioSchema = z.object({
  openPositions: z.array(z.record(z.unknown())).optional().default([]),
  closedPositions: z.array(z.record(z.unknown())).optional().default([]),
  totalPnl: z.string().optional(),
  tradeCount: z.number().int().min(0).optional(),
});

const ExplainSignalSchema = z.object({
  signal: z.record(z.unknown()),
  candles: z.array(z.record(z.unknown())).optional(),
});

const ModelPreferenceSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

const AiModelPatchSchema = z.object({
  primary: ModelPreferenceSchema.nullable().optional(),
  fallback1: ModelPreferenceSchema.nullable().optional(),
  fallback2: ModelPreferenceSchema.nullable().optional(),
});

// --- Known providers and their env-key lookup ---

const KNOWN_PROVIDERS = ['openai', 'anthropic', 'openrouter', 'together', 'fireworks', 'mistral', 'cohere', 'google'];

/**
 * Resolve the API key for a provider when actually calling it.
 * Falls back to the generic LLM_API_KEY so operators can use a single key for one provider.
 */
function resolveApiKey(provider: string): string | undefined {
  return process.env[`LLM_API_KEY_${provider.toUpperCase()}`] ?? process.env['LLM_API_KEY'];
}

/**
 * Check whether a specific provider is explicitly configured.
 * Only returns true when the provider has its own dedicated key — NOT the generic fallback.
 * This prevents a single LLM_API_KEY from spuriously advertising all 8 providers as available.
 */
function isProviderExplicitlyConfigured(provider: string): boolean {
  return !!process.env[`LLM_API_KEY_${provider.toUpperCase()}`];
}

function getConfiguredProviders(): string[] {
  return KNOWN_PROVIDERS.filter(isProviderExplicitlyConfigured);
}

/**
 * Returns the full set of providers available to serve requests.
 * Includes all explicitly-keyed providers, plus the operator's configured
 * provider when it is reachable via the generic LLM_API_KEY fallback.
 * This covers the common deployment pattern: provider=openai + LLM_API_KEY=sk-...
 */
function getAvailableProviders(operatorProvider: string): string[] {
  const explicit = getConfiguredProviders();
  // If the operator's provider is already in the explicit list nothing extra is needed.
  // Otherwise, add it when resolveApiKey finds a key for it (e.g. generic LLM_API_KEY).
  if (resolveApiKey(operatorProvider) && !explicit.includes(operatorProvider)) {
    return [...explicit, operatorProvider];
  }
  return explicit;
}

async function resolveUserLlmConfig(
  db: Database,
  userId: string,
  baseConfig: LlmConfig,
): Promise<{ provider: string; model: string; baseUrl: string | undefined; timeoutMs: number }> {
  const [user] = await db.select({ aiModelConfig: users.aiModelConfig }).from(users).where(eq(users.id, userId));
  const userModelConfig = user?.aiModelConfig as Record<string, unknown> | null | undefined;
  for (const key of ['primary', 'fallback1', 'fallback2'] as const) {
    const pref = userModelConfig?.[key] as { provider: string; model: string } | null | undefined;
    // Only use a user preference when the provider has its own dedicated key.
    // Using the generic LLM_API_KEY fallback here would silently send requests to
    // the wrong provider with an incompatible credential.
    if (pref?.provider && pref?.model && isProviderExplicitlyConfigured(pref.provider)) {
      // Keep the operator-configured baseUrl (proxy / gateway) even when the user selects a different model.
      return { provider: pref.provider, model: pref.model, baseUrl: baseConfig.baseUrl, timeoutMs: baseConfig.timeoutMs };
    }
  }
  return { provider: baseConfig.provider, model: baseConfig.model, baseUrl: baseConfig.baseUrl, timeoutMs: baseConfig.timeoutMs };
}

const NO_AI_PROVIDER = { error: 'no_ai_provider', message: 'No AI provider is configured on this platform' };

// --- Route module ---

export async function aiRoutes(
  app: FastifyInstance,
  db: Database,
  llmConfig: LlmConfig,
  redisClient: Redis,
): Promise<void> {
  // GET /ai/available-models — list configured providers only
  app.get('/ai/available-models', async (_request, reply) => {
    const configured = getAvailableProviders(llmConfig.provider);
    if (configured.length === 0) {
      return reply.status(503).send(NO_AI_PROVIDER);
    }

    // Curated model lists per provider
    const PROVIDER_MODELS: Record<string, string[]> = {
      openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
      anthropic: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-3-5'],
      openrouter: ['anthropic/claude-sonnet-4-5', 'openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct'],
      together: ['meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', 'mistralai/Mixtral-8x7B-Instruct-v0.1'],
      fireworks: ['accounts/fireworks/models/llama-v3p1-70b-instruct'],
      mistral: ['mistral-large-latest', 'mistral-small-latest'],
      cohere: ['command-r-plus', 'command-r'],
      google: ['gemini-1.5-pro', 'gemini-1.5-flash'],
    };

    const providers = configured.map((p) => ({
      provider: p,
      models: PROVIDER_MODELS[p] ?? [],
    }));

    return reply.send({ providers });
  });

  // POST /ai/generate-config — generate blueprint configData from freeform text (rate-limited 10/min)
  app.post<{ Body: unknown }>('/ai/generate-config', async (request, reply) => {
    const configured = getAvailableProviders(llmConfig.provider);
    if (configured.length === 0) return reply.status(503).send(NO_AI_PROVIDER);

    // Rate limit 10/min per user
    const rateLimitKey = `ratelimit:ai:generate:${request.userId}`;
    const count = await redisClient.incr(rateLimitKey);
    if (count === 1) await redisClient.expire(rateLimitKey, 60);
    if (count > 10) return reply.status(429).send({ error: 'rate_limited', message: 'Maximum 10 AI config generations per minute' });

    const parsed = GenerateConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const effectiveConfig = await resolveUserLlmConfig(db, request.userId, llmConfig);
    const systemPrompt = `You are a trading strategy configuration assistant.
Given a user's description, generate a JSON object representing a trading bot configuration.
The config must include these sections: strategy, risk, execution.
- strategy: { preset, params } where preset is one of: momentum, dca, range, swing, scalper, contrarian
- risk: { maxPositionSizePct, stopLossPct, takeProfitPct }
- execution: { mode } where mode is one of: paper, shadow, live

Respond with ONLY a valid JSON object, no prose.`;

    const result = await callLlmProvider(
      { provider: effectiveConfig.provider, model: effectiveConfig.model, maxTokens: 1024, timeoutMs: effectiveConfig.timeoutMs, baseUrl: effectiveConfig.baseUrl },
      { messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: parsed.data.text }], maxTokens: 1024 },
    );

    if (!result.ok) {
      return reply.status(502).send({ error: 'ai_error', message: result.error.message });
    }

    let configData: Record<string, unknown>;
    try {
      // Extract JSON from the response (may be wrapped in markdown code blocks)
      const text = result.data.content;
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? [null, text];
      configData = JSON.parse(jsonMatch[1]!) as Record<string, unknown>;
    } catch {
      return reply.status(502).send({ error: 'ai_parse_error', message: 'AI returned invalid JSON', raw: result.data.content });
    }

    // Validate the returned configData has required sections
    const strategy = configData['strategy'];
    const risk = configData['risk'];
    const execution = configData['execution'];
    if (
      !strategy || typeof strategy !== 'object' || Array.isArray(strategy) ||
      !risk || typeof risk !== 'object' || Array.isArray(risk) ||
      !execution || typeof execution !== 'object' || Array.isArray(execution)
    ) {
      return reply.status(502).send({
        error: 'ai_invalid_config',
        message: 'AI response is missing required configData sections (strategy, risk, execution)',
        raw: configData,
      });
    }

    return reply.send({ configData, model: result.data.model, tokensUsed: result.data.tokensUsed });
  });

  // POST /ai/analyze-portfolio — AI portfolio analysis
  app.post<{ Body: unknown }>('/ai/analyze-portfolio', async (request, reply) => {
    const configured = getAvailableProviders(llmConfig.provider);
    if (configured.length === 0) return reply.status(503).send(NO_AI_PROVIDER);

    const parsed = AnalyzePortfolioSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const effectiveConfig = await resolveUserLlmConfig(db, request.userId, llmConfig);
    const { openPositions, closedPositions, totalPnl, tradeCount } = parsed.data;
    const portfolioSummary = JSON.stringify({
      openPositions: openPositions.slice(0, 20),
      closedPositions: closedPositions.slice(0, 20),
      totalPnl,
      tradeCount,
    }, null, 2);

    const result = await callLlmProvider(
      { provider: effectiveConfig.provider, model: effectiveConfig.model, maxTokens: 2048, timeoutMs: effectiveConfig.timeoutMs, baseUrl: effectiveConfig.baseUrl },
      {
        messages: [
          { role: 'system', content: 'You are a professional trading portfolio analyst. Analyze the portfolio data and provide concise, actionable insights about performance, risk, and improvement opportunities.' },
          { role: 'user', content: `Analyze this portfolio:\n${portfolioSummary}` },
        ],
        maxTokens: 2048,
      },
    );

    if (!result.ok) return reply.status(502).send({ error: 'ai_error', message: result.error.message });

    return reply.send({ analysis: result.data.content, model: result.data.model, tokensUsed: result.data.tokensUsed });
  });

  // POST /ai/explain-signal — AI explanation of a trade signal
  app.post<{ Body: unknown }>('/ai/explain-signal', async (request, reply) => {
    const configured = getAvailableProviders(llmConfig.provider);
    if (configured.length === 0) return reply.status(503).send(NO_AI_PROVIDER);

    const parsed = ExplainSignalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const effectiveConfig = await resolveUserLlmConfig(db, request.userId, llmConfig);
    const context = JSON.stringify({
      signal: parsed.data.signal,
      ...(parsed.data.candles ? { candles: parsed.data.candles.slice(0, 50) } : {}),
    }, null, 2);

    const result = await callLlmProvider(
      { provider: effectiveConfig.provider, model: effectiveConfig.model, maxTokens: 1024, timeoutMs: effectiveConfig.timeoutMs, baseUrl: effectiveConfig.baseUrl },
      {
        messages: [
          { role: 'system', content: 'You are a trading signal analyst. Explain the given trade signal in plain language, describing what it indicates, why it may have been generated, and what action it suggests.' },
          { role: 'user', content: `Explain this signal:\n${context}` },
        ],
        maxTokens: 1024,
      },
    );

    if (!result.ok) return reply.status(502).send({ error: 'ai_error', message: result.error.message });

    return reply.send({ explanation: result.data.content, model: result.data.model, tokensUsed: result.data.tokensUsed });
  });

  // PATCH /settings/ai-model — set user's AI model preference chain
  app.patch<{ Body: unknown }>('/settings/ai-model', async (request, reply) => {
    const parsed = AiModelPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const existing = await db.select({ aiModelConfig: users.aiModelConfig })
      .from(users).where(eq(users.id, request.userId));
    const current = (existing[0]?.aiModelConfig ?? {}) as Record<string, unknown>;

    const updated: Record<string, unknown> = { ...current };
    if (parsed.data.primary !== undefined) updated['primary'] = parsed.data.primary;
    if (parsed.data.fallback1 !== undefined) updated['fallback1'] = parsed.data.fallback1;
    if (parsed.data.fallback2 !== undefined) updated['fallback2'] = parsed.data.fallback2;

    await db.update(users).set({ aiModelConfig: updated, updatedAt: new Date() })
      .where(eq(users.id, request.userId));

    return reply.send({ aiModelConfig: updated });
  });
}

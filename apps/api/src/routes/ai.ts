import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { users } from '@herobids/db';
import { callLlmProvider } from '@herobids/llm';
import type { AppConfig, ProvidersYaml, AgentRuntimeConfig } from '@herobids/domain';
import { normalizePersistedAiModelConfig } from '@herobids/domain';
import type { LlmCatalogDeps } from '../llm-model-catalog.js';
import { getAvailableProviders, getProviderCatalogEntry, makeCatalogContext, revalidatePersistedSelection, validateAiModelSelection } from '../llm-model-catalog.js';

type LlmConfig = AppConfig['llm'];

function makeDeps(db: Database, providersYaml: ProvidersYaml, llmConfig: LlmConfig): LlmCatalogDeps {
  return { db, providersYaml, context: makeCatalogContext(llmConfig) };
}

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

const AiModelConfigSchema = z.object({
  provider: z.string().min(1),
  lightModel: z.string().min(1),
  heavyModel: z.string().min(1),
});

const ClearedAiModelConfigSchema = z.object({
  provider: z.null(),
  lightModel: z.null(),
  heavyModel: z.null(),
});

const AiModelPatchSchema = z.union([AiModelConfigSchema, ClearedAiModelConfigSchema]);

async function canServeProviderSelection(selectedProvider: string, deps: LlmCatalogDeps): Promise<boolean> {
  const providers = await getAvailableProviders(deps);
  return providers.includes(selectedProvider);
}

async function resolveUserLlmConfig(
  db: Database,
  userId: string,
  baseConfig: LlmConfig,
  providersYaml: ProvidersYaml,
): Promise<{ provider: string; model: string; baseUrl: string | undefined; timeoutMs: number }> {
  const [user] = await db.select({ aiModelConfig: users.aiModelConfig }).from(users).where(eq(users.id, userId));
  const userModelConfig = normalizePersistedAiModelConfig(user?.aiModelConfig);
  const selectedProvider = userModelConfig?.provider;
  const selectedHeavyModel = userModelConfig?.heavyModel ?? userModelConfig?.lightModel;

  if (
    selectedProvider
    && selectedHeavyModel
    && await canServeProviderSelection(selectedProvider, makeDeps(db, providersYaml, baseConfig))
  ) {
    // For dynamic providers, revalidate against the live catalog so stale
    // persisted selections don't route to models that no longer exist.
    const deps = makeDeps(db, providersYaml, baseConfig);
    const stillValid = await revalidatePersistedSelection(userModelConfig, deps);
    if (!stillValid) {
      return { provider: baseConfig.provider, model: baseConfig.model, baseUrl: baseConfig.baseUrl, timeoutMs: baseConfig.timeoutMs };
    }

    // Keep the operator-configured baseUrl (proxy / gateway) even when the user selects a different model.
    return {
      provider: selectedProvider,
      model: selectedHeavyModel,
      baseUrl: baseConfig.baseUrl,
      timeoutMs: baseConfig.timeoutMs,
    };
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
  providersYaml: ProvidersYaml,
  agentRuntime: AgentRuntimeConfig,
): Promise<void> {
  const deps = makeDeps(db, providersYaml, llmConfig);
  // GET /ai/available-models — list configured providers and operator model defaults
  app.get('/ai/available-models', async (_request, reply) => {
    const configured = await getAvailableProviders(deps);
    if (configured.length === 0) {
      return reply.status(503).send(NO_AI_PROVIDER);
    }

    const providers = await Promise.all(
      configured.map((provider) => getProviderCatalogEntry(provider, deps)),
    );

    const modelDefaults = agentRuntime.llm.modelDefaults;
    const defaults = modelDefaults?.provider
      ? {
          provider: modelDefaults.provider,
          lightModel: modelDefaults.lightModel ?? null,
          heavyModel: modelDefaults.heavyModel ?? null,
        }
      : null;

    return reply.send({ providers, defaults });
  });

  app.get('/settings/ai-model', async (request, reply) => {
    const [user] = await db.select({ aiModelConfig: users.aiModelConfig }).from(users).where(eq(users.id, request.userId));
    const raw = user?.aiModelConfig;
    const rawProvider = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['provider']
      : undefined;
    const providerConfig = typeof rawProvider === 'string' ? providersYaml.providers[rawProvider] : undefined;
    const normalized = normalizePersistedAiModelConfig(raw, providerConfig);
    if (normalized) {
      const stillValid = await revalidatePersistedSelection(normalized, deps);
      if (!stillValid) {
        return reply.send({ aiModelConfig: null });
      }
    }
    return reply.send({ aiModelConfig: normalized });
  });

  // POST /ai/generate-config — generate blueprint configData from freeform text (rate-limited 10/min)
  app.post<{ Body: unknown }>('/ai/generate-config', async (request, reply) => {
    const configured = await getAvailableProviders(deps);
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

    const effectiveConfig = await resolveUserLlmConfig(db, request.userId, llmConfig, providersYaml);
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
    const configured = await getAvailableProviders(deps);
    if (configured.length === 0) return reply.status(503).send(NO_AI_PROVIDER);

    const parsed = AnalyzePortfolioSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const effectiveConfig = await resolveUserLlmConfig(db, request.userId, llmConfig, providersYaml);
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
    const configured = await getAvailableProviders(deps);
    if (configured.length === 0) return reply.status(503).send(NO_AI_PROVIDER);

    const parsed = ExplainSignalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const effectiveConfig = await resolveUserLlmConfig(db, request.userId, llmConfig, providersYaml);
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

    if (parsed.data.provider !== null) {
      const issues = await validateAiModelSelection(parsed.data, deps);
      if (issues.length > 0) {
        return reply.status(400).send({ error: 'validation_error', details: issues });
      }
    }

    const updated = parsed.data.provider === null ? null : parsed.data;

    await db.update(users).set({ aiModelConfig: updated, updatedAt: new Date() })
      .where(eq(users.id, request.userId));

    return reply.send({ aiModelConfig: updated });
  });
}

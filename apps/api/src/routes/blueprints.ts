import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, or, sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { blueprints, bots } from '@herobids/db';
import { extractStrategyFromConfig } from '@herobids/domain';

// --- Static preset catalogue ---

const PRESET_KEYS = ['momentum', 'momentum-position', 'dca', 'range', 'swing', 'scalper', 'contrarian'] as const;
type PresetKey = typeof PRESET_KEYS[number];

const PRESETS: Record<PresetKey, { name: string; description: string; configData: Record<string, unknown> }> = {
  momentum: {
    name: 'Momentum — Day',
    description: 'Day-trend following on 15m candles. Tight stop, quick profit targets.',
    configData: {
      strategy: {
        type: 'momentum',
        decisionMode: 'mechanical',
        params: {
          candleInterval: '15m',
          candleLimit: 48,
          minCandleCount: 20,
          stopLossPct: 3,
          takeProfitPct: 8,
          signalBias: 'trend-following',
          positionSize: '1',
          positionSizeMode: 'fixed',
          indicators: {
            rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70 },
            macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
            volume: { enabled: true, strongRatio: 1.5 },
            supportResistance: { enabled: false },
            vwap: { enabled: false },
            priceAction: { enabled: true, minChange24hPct: 3, maxChange24hPct: 50 },
            choch: { enabled: false },
            confidence: { rsiWeight: 0.25, macdCrossoverWeight: 0.30, macdIncreasingWeight: 0.15, volumeWeight: 0.20, breakoutWeight: 0.10, vwapWeight: 0, priceActionWeight: 0.10, chochBullishWeight: 0.15, chochBearishPenalty: 0.10, minConfidence: 0.40, minReasons: 2 },
          },
        },
      },
      risk: { maxPositionSize: 1000, stopLossPercent: 3, takeProfitPercent: 8 },
      execution: { mode: 'paper' },
    },
  },
  'momentum-position': {
    name: 'Momentum — Position',
    description: 'Longer-term trend following on 4H candles. Wider stops, bigger targets.',
    configData: {
      strategy: {
        type: 'momentum',
        decisionMode: 'mechanical',
        params: {
          candleInterval: '4H',
          candleLimit: 72,
          minCandleCount: 30,
          stopLossPct: 8,
          takeProfitPct: 25,
          signalBias: 'trend-following',
          positionSize: '1',
          positionSizeMode: 'fixed',
          indicators: {
            rsi: { enabled: true, period: 14, healthyMin: 45, healthyMax: 75 },
            macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
            volume: { enabled: true, strongRatio: 1.8 },
            supportResistance: { enabled: true, lookback: 24, breakoutThreshold: 0.01 },
            vwap: { enabled: false },
            priceAction: { enabled: true, minChange24hPct: 8, maxChange24hPct: 60 },
            choch: { enabled: false },
            confidence: { rsiWeight: 0.20, macdCrossoverWeight: 0.25, macdIncreasingWeight: 0.20, volumeWeight: 0.20, breakoutWeight: 0.15, vwapWeight: 0, priceActionWeight: 0.10, chochBullishWeight: 0.15, chochBearishPenalty: 0.10, minConfidence: 0.45, minReasons: 2 },
          },
        },
      },
      risk: { maxPositionSize: 1000, stopLossPercent: 8, takeProfitPercent: 25 },
      execution: { mode: 'paper' },
    },
  },
  dca: {
    name: 'DCA',
    description: 'Dollar-cost averaging with periodic buys at a fixed interval.',
    configData: {
      strategy: { type: 'dca', params: { intervalMs: 86400000, amountPerBuy: '10' } },
      risk: { maxTotalPosition: 10000 },
      execution: { mode: 'paper' },
    },
  },
  range: {
    name: 'Range Trading',
    description: 'Mean-reverting within ranges. Uses support/resistance bounces, RSI extremes.',
    configData: {
      strategy: {
        type: 'range',
        decisionMode: 'mechanical',
        params: {
          candleInterval: '1H',
          candleLimit: 48,
          minCandleCount: 20,
          stopLossPct: 4,
          takeProfitPct: 8,
          signalBias: 'mean-reverting',
          positionSize: '1',
          positionSizeMode: 'fixed',
          indicators: {
            rsi: { enabled: true, period: 14, overbought: 75, weakBelow: 25 },
            macd: { enabled: false },
            volume: { enabled: true, strongRatio: 1.3 },
            supportResistance: { enabled: true, lookback: 30, breakoutThreshold: 0.005 },
            vwap: { enabled: false },
            priceAction: { enabled: false },
            choch: { enabled: false },
            confidence: { rsiWeight: 0.40, macdCrossoverWeight: 0, macdIncreasingWeight: 0, volumeWeight: 0.20, breakoutWeight: 0.40, vwapWeight: 0, priceActionWeight: 0, chochBullishWeight: 0, chochBearishPenalty: 0, minConfidence: 0.35, minReasons: 2 },
          },
        },
      },
      risk: { maxPositionSize: 1000, stopLossPercent: 4, takeProfitPercent: 8 },
      execution: { mode: 'paper' },
    },
  },
  swing: {
    name: 'Swing',
    description: 'Medium-term swing trading. 4H candles, CHOCH confirmations, moderate risk.',
    configData: {
      strategy: {
        type: 'swing',
        decisionMode: 'mechanical',
        params: {
          candleInterval: '4H',
          candleLimit: 48,
          minCandleCount: 20,
          stopLossPct: 5,
          takeProfitPct: 15,
          signalBias: 'trend-following',
          positionSize: '1',
          positionSizeMode: 'fixed',
          indicators: {
            rsi: { enabled: true, period: 14, healthyMin: 48, healthyMax: 68 },
            macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
            volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.8 },
            supportResistance: { enabled: true, lookback: 24, breakoutThreshold: 0.01 },
            vwap: { enabled: false },
            priceAction: { enabled: true, minChange24hPct: 5, maxChange24hPct: 50 },
            choch: { enabled: true, swingLookback: 3, minSwingPct: 0.015, rejectOnBearish: true },
            confidence: { rsiWeight: 0.20, macdCrossoverWeight: 0.25, macdIncreasingWeight: 0.15, breakoutWeight: 0.25, volumeWeight: 0.20, vwapWeight: 0, priceActionWeight: 0.10, chochBullishWeight: 0.20, chochBearishPenalty: 0.15, minConfidence: 0.40, minReasons: 2 },
          },
        },
      },
      risk: { maxPositionSize: 2000, stopLossPercent: 5, takeProfitPercent: 15 },
      execution: { mode: 'paper' },
    },
  },
  scalper: {
    name: 'Scalper',
    description: 'Quick entries on 5m candles. Tight stops, fast exits, volume confirmation.',
    configData: {
      strategy: {
        type: 'scalper',
        decisionMode: 'mechanical',
        params: {
          candleInterval: '5m',
          candleLimit: 30,
          minCandleCount: 15,
          stopLossPct: 2,
          takeProfitPct: 5,
          signalBias: 'trend-following',
          positionSize: '1',
          positionSizeMode: 'fixed',
          indicators: {
            rsi: { enabled: true, period: 7, healthyMin: 45, healthyMax: 65 },
            macd: { enabled: true, fast: 6, slow: 13, signal: 5 },
            volume: { enabled: true, strongRatio: 1.8, recentBars: 3, avgBars: 10 },
            supportResistance: { enabled: false },
            vwap: { enabled: false },
            priceAction: { enabled: false },
            choch: { enabled: false },
            confidence: { rsiWeight: 0.30, macdCrossoverWeight: 0.35, macdIncreasingWeight: 0.15, volumeWeight: 0.25, breakoutWeight: 0.05, vwapWeight: 0, priceActionWeight: 0, chochBullishWeight: 0.10, chochBearishPenalty: 0.05, minConfidence: 0.35, minReasons: 2 },
          },
        },
      },
      risk: { maxPositionSize: 500, stopLossPercent: 2, takeProfitPercent: 5 },
      execution: { mode: 'paper' },
    },
  },
  contrarian: {
    name: 'Contrarian',
    description: 'Fades extreme momentum. Mean-reverting against overbought/oversold signals.',
    configData: {
      strategy: {
        type: 'contrarian',
        decisionMode: 'mechanical',
        params: {
          candleInterval: '1H',
          candleLimit: 48,
          minCandleCount: 20,
          stopLossPct: 5,
          takeProfitPct: 12,
          signalBias: 'mean-reverting',
          positionSize: '1',
          positionSizeMode: 'fixed',
          indicators: {
            rsi: { enabled: true, period: 14, overbought: 70, weakBelow: 30 },
            macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
            volume: { enabled: true, strongRatio: 1.5 },
            supportResistance: { enabled: true, lookback: 24, breakoutThreshold: 0.008 },
            vwap: { enabled: false },
            priceAction: { enabled: true, minChange24hPct: 10, maxChange24hPct: 40 },
            choch: { enabled: true, swingLookback: 3, minSwingPct: 0.01, rejectOnBearish: false },
            confidence: { rsiWeight: 0.35, macdCrossoverWeight: 0.15, macdIncreasingWeight: 0.10, volumeWeight: 0.20, breakoutWeight: 0.20, vwapWeight: 0, priceActionWeight: 0.10, chochBullishWeight: 0.10, chochBearishPenalty: 0.05, minConfidence: 0.40, minReasons: 2 },
          },
        },
      },
      risk: { maxPositionSize: 1000, stopLossPercent: 5, takeProfitPercent: 12 },
      execution: { mode: 'paper' },
    },
  },
};

const DEFAULTS = {
  strategy: {
    type: 'momentum',
    decisionMode: 'mechanical',
    params: {
      candleInterval: '15m',
      candleLimit: 48,
      minCandleCount: 20,
      stopLossPct: 3,
      takeProfitPct: 8,
      signalBias: 'trend-following',
      positionSize: '1',
      positionSizeMode: 'fixed',
    },
  },
  risk: { maxPositionSize: 1000, stopLossPercent: 3, takeProfitPercent: 8 },
  execution: { mode: 'paper' },
};

// --- Request schemas ---

const CreateBlueprintSchema = z.object({
  name: z.string().min(1).max(120),
  configData: z.record(z.unknown()),
  description: z.string().max(500).optional(),
});

const UpdateBlueprintSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  configData: z.record(z.unknown()).optional(),
  description: z.string().max(500).nullable().optional(),
});

const FromPresetSchema = z.object({
  preset: z.enum(PRESET_KEYS),
  name: z.string().min(1).max(120).optional(),
  overrides: z.record(z.unknown()).optional(),
});

// --- Helper ---

/** Returns the blueprint if the authenticated user owns it, or if it is public. */
async function resolveBlueprintForRead(
  db: Database,
  id: string,
  userId: string,
): Promise<typeof blueprints.$inferSelect | null> {
  const [bp] = await db.select().from(blueprints)
    .where(and(
      eq(blueprints.id, id),
      or(eq(blueprints.userId, userId), eq(blueprints.visibility, 'public')),
    ));
  return bp ?? null;
}

/** Returns the blueprint only if the authenticated user owns it (for mutations). */
async function resolveBlueprintForWrite(
  db: Database,
  id: string,
  userId: string,
): Promise<typeof blueprints.$inferSelect | null> {
  const [bp] = await db.select().from(blueprints)
    .where(and(eq(blueprints.id, id), eq(blueprints.userId, userId)));
  return bp ?? null;
}

// --- Route module ---

export async function blueprintRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET /blueprints/presets — static list of available strategy presets
  // Registered before /:id so Fastify doesn't swallow it as a param.
  app.get('/blueprints/presets', async (_request, reply) => {
    const presets = PRESET_KEYS.map((key) => ({
      key,
      name: PRESETS[key].name,
      description: PRESETS[key].description,
    }));
    return reply.send({ presets });
  });

  // GET /blueprints/defaults — default strategy/risk/execution values
  app.get('/blueprints/defaults', async (_request, reply) => {
    return reply.send({ defaults: DEFAULTS });
  });

  // POST /blueprints/from-preset — create a blueprint pre-populated from a preset
  app.post<{ Body: unknown }>('/blueprints/from-preset', async (request, reply) => {
    const parsed = FromPresetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const preset = PRESETS[parsed.data.preset];
    // Section-level merge: for each top-level key, if both sides are plain objects,
    // merge them one level deep so that e.g. { strategy: { lookbackPeriod: 21 } }
    // adds/overrides that one field without discarding sibling fields like type.
    const base = preset.configData;
    const rawOverrides = parsed.data.overrides ?? {};
    const configData: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(rawOverrides)) {
      const existing = configData[k];
      configData[k] = (
        existing !== null && typeof existing === 'object' && !Array.isArray(existing) &&
        v !== null && typeof v === 'object' && !Array.isArray(v)
      ) ? { ...(existing as Record<string, unknown>), ...(v as Record<string, unknown>) } : v;
    }
    const name = parsed.data.name ?? `${preset.name} Blueprint`;

    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(blueprints).values({
      id,
      userId: request.userId,
      name,
      configData,
      configVersion: 1,
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    });

    const [bp] = await db.select().from(blueprints).where(eq(blueprints.id, id));
    return reply.status(201).send(bp);
  });

  // GET /blueprints — list user's own blueprints
  app.get('/blueprints', async (request, reply) => {
    const rows = await db.select().from(blueprints)
      .where(eq(blueprints.userId, request.userId));
    const blueprintsWithType = rows.map((b) => ({
      ...b,
      strategyType: extractStrategyFromConfig(b.configData)?.type ?? null,
    }));
    return reply.send({ blueprints: blueprintsWithType });
  });

  // POST /blueprints — create a new blueprint
  app.post<{ Body: unknown }>('/blueprints', async (request, reply) => {
    const parsed = CreateBlueprintSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(blueprints).values({
      id,
      userId: request.userId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      configData: parsed.data.configData,
      configVersion: 1,
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    });

    const [bp] = await db.select().from(blueprints).where(eq(blueprints.id, id));
    return reply.status(201).send(bp);
  });

  // GET /blueprints/:id — get a single blueprint (owned or public)
  app.get<{ Params: { id: string } }>('/blueprints/:id', async (request, reply) => {
    const bp = await resolveBlueprintForRead(db, request.params.id, request.userId);
    if (!bp) return reply.status(404).send({ error: 'not_found' });
    return reply.send({
      ...bp,
      strategyType: extractStrategyFromConfig(bp.configData)?.type ?? null,
    });
  });

  // PUT /blueprints/:id — update blueprint and increment configVersion
  app.put<{ Params: { id: string }; Body: unknown }>('/blueprints/:id', async (request, reply) => {
    const parsed = UpdateBlueprintSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const result = await db.transaction(async (tx) => {
      // Serialize concurrent edits for the same blueprint so configVersion and
      // merge semantics are derived from a stable, locked row state.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(2, hashtext(${request.params.id}))`);

      const bp = await resolveBlueprintForWrite(tx as unknown as Database, request.params.id, request.userId);
      if (!bp) return { kind: 'not_found' as const };

      const updateFields: Partial<typeof blueprints.$inferInsert> = {
        updatedAt: new Date(),
        // Always increment configVersion on every PUT so callers can use it as a
        // general write token (per plan acceptance criteria).
        configVersion: bp.configVersion + 1,
      };
      if (parsed.data.name !== undefined) updateFields.name = parsed.data.name;
      if (parsed.data.description !== undefined) updateFields.description = parsed.data.description ?? null;
      if (parsed.data.configData !== undefined) {
        // Section-level merge with existing configData: treat each top-level key
        // as a section and shallow-merge plain object values one level deep.
        // This keeps untouched sections (e.g. 'risk', 'execution') intact when
        // the caller only wants to update a single section.
        const existingConfig = bp.configData as Record<string, unknown>;
        const merged: Record<string, unknown> = { ...existingConfig };
        for (const [k, v] of Object.entries(parsed.data.configData)) {
          const existing = merged[k];
          merged[k] = (
            existing !== null && typeof existing === 'object' && !Array.isArray(existing) &&
            v !== null && typeof v === 'object' && !Array.isArray(v)
          ) ? { ...(existing as Record<string, unknown>), ...(v as Record<string, unknown>) } : v;
        }
        updateFields.configData = merged;
      }

      await tx.update(blueprints).set(updateFields).where(eq(blueprints.id, request.params.id));
      const [updated] = await tx.select().from(blueprints).where(eq(blueprints.id, request.params.id));
      return { kind: 'updated' as const, blueprint: updated };
    });

    if (result.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    const updated = result.blueprint;
    return reply.send(updated);
  });

  // DELETE /blueprints/:id — delete blueprint (blocked if referenced by any running bot)
  app.delete<{ Params: { id: string } }>('/blueprints/:id', async (request, reply) => {
    const blueprintId = request.params.id;
    const deleted = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(2, hashtext(${blueprintId}))`);

      const bp = await resolveBlueprintForWrite(tx as unknown as Database, blueprintId, request.userId);
      if (!bp) return 'not_found' as const;

      const [runningBot] = await tx.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.blueprintId, blueprintId), eq(bots.status, 'running')));
      if (runningBot) return 'in_use' as const;

      await tx.delete(blueprints).where(eq(blueprints.id, blueprintId));
      return 'deleted' as const;
    });

    if (deleted === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (deleted === 'in_use') {
      return reply.status(409).send({
        error: 'blueprint_in_use',
        message: 'Cannot delete a blueprint referenced by a running bot. Stop all running bots first.',
      });
    }
    return reply.status(204).send();
  });

  // POST /blueprints/:id/clone — create an independent copy of a blueprint
  app.post<{ Params: { id: string } }>('/blueprints/:id/clone', async (request, reply) => {
    // Clone is a read operation (owner or public can clone).
    const bp = await resolveBlueprintForRead(db, request.params.id, request.userId);
    if (!bp) return reply.status(404).send({ error: 'not_found' });

    const newId = crypto.randomUUID();
    const now = new Date();
    await db.insert(blueprints).values({
      id: newId,
      userId: request.userId,
      name: `${bp.name} (copy)`,
      description: bp.description,
      configData: bp.configData,
      configVersion: 1,
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    });

    const [clone] = await db.select().from(blueprints).where(eq(blueprints.id, newId));
    return reply.status(201).send(clone);
  });

  // POST /blueprints/:id/publish — set visibility to public
  app.post<{ Params: { id: string } }>('/blueprints/:id/publish', async (request, reply) => {
    const blueprintId = request.params.id;
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(2, hashtext(${blueprintId}))`);
      const bp = await resolveBlueprintForWrite(tx as unknown as Database, blueprintId, request.userId);
      if (!bp) return 'not_found' as const;
      await tx.update(blueprints).set({ visibility: 'public', updatedAt: new Date() }).where(eq(blueprints.id, blueprintId));
      return 'ok' as const;
    });
    if (result === 'not_found') return reply.status(404).send({ error: 'not_found' });
    return reply.send({ blueprintId, visibility: 'public' });
  });

  // POST /blueprints/:id/unpublish — set visibility to private
  app.post<{ Params: { id: string } }>('/blueprints/:id/unpublish', async (request, reply) => {
    const blueprintId = request.params.id;
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(2, hashtext(${blueprintId}))`);
      const bp = await resolveBlueprintForWrite(tx as unknown as Database, blueprintId, request.userId);
      if (!bp) return 'not_found' as const;
      await tx.update(blueprints).set({ visibility: 'private', updatedAt: new Date() }).where(eq(blueprints.id, blueprintId));
      return 'ok' as const;
    });
    if (result === 'not_found') return reply.status(404).send({ error: 'not_found' });
    return reply.send({ blueprintId, visibility: 'private' });
  });
}

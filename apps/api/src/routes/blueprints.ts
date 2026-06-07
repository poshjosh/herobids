import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, or, sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { blueprints, bots } from '@herobids/db';

// --- Static preset catalogue ---

const PRESET_KEYS = ['momentum', 'dca', 'range', 'swing', 'scalper', 'contrarian'] as const;
type PresetKey = typeof PRESET_KEYS[number];

const PRESETS: Record<PresetKey, { name: string; description: string; configData: Record<string, unknown> }> = {
  momentum: {
    name: 'Momentum',
    description: 'Trend-following strategy using momentum indicators.',
    configData: {
      strategy: { type: 'momentum', lookbackPeriod: 14, entryThreshold: 0.02, exitThreshold: 0.01 },
      risk: { maxPositionSize: 1000, stopLossPercent: 2, takeProfitPercent: 4 },
      execution: { mode: 'paper', orderType: 'market' },
    },
  },
  dca: {
    name: 'DCA',
    description: 'Dollar-cost averaging with periodic buys at a fixed interval.',
    configData: {
      strategy: { type: 'dca', intervalHours: 24, amount: 100 },
      risk: { maxTotalPosition: 10000 },
      execution: { mode: 'paper', orderType: 'market' },
    },
  },
  range: {
    name: 'Range',
    description: 'Range-bound trading: buy at support, sell at resistance.',
    configData: {
      strategy: { type: 'range', supportLevel: null, resistanceLevel: null, bufferPercent: 0.5 },
      risk: { maxPositionSize: 1000, stopLossPercent: 3 },
      execution: { mode: 'paper', orderType: 'limit' },
    },
  },
  swing: {
    name: 'Swing',
    description: 'Multi-day swing trading on higher timeframes using RSI.',
    configData: {
      strategy: { type: 'swing', timeframe: '4h', entryRsi: 30, exitRsi: 70 },
      risk: { maxPositionSize: 2000, stopLossPercent: 5, takeProfitPercent: 10 },
      execution: { mode: 'paper', orderType: 'limit' },
    },
  },
  scalper: {
    name: 'Scalper',
    description: 'High-frequency small-profit scalping with tight stops.',
    configData: {
      strategy: { type: 'scalper', targetProfitBps: 10, maxHoldMinutes: 5 },
      risk: { maxPositionSize: 500, stopLossPercent: 0.5 },
      execution: { mode: 'paper', orderType: 'limit' },
    },
  },
  contrarian: {
    name: 'Contrarian',
    description: 'Counter-trend strategy fading extreme RSI moves.',
    configData: {
      strategy: { type: 'contrarian', rsiOverbought: 80, rsiOversold: 20, lookbackPeriod: 14 },
      risk: { maxPositionSize: 1000, stopLossPercent: 3, takeProfitPercent: 6 },
      execution: { mode: 'paper', orderType: 'limit' },
    },
  },
};

const DEFAULTS = {
  strategy: { type: 'momentum', lookbackPeriod: 14 },
  risk: { maxPositionSize: 1000, stopLossPercent: 2 },
  execution: { mode: 'paper', orderType: 'market' },
};

// --- Request schemas ---

const CreateBlueprintSchema = z.object({
  name: z.string().min(1).max(120),
  configData: z.record(z.unknown()),
  description: z.string().max(500).optional(),
  strategyPreset: z.enum(PRESET_KEYS).optional(),
});

const UpdateBlueprintSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  configData: z.record(z.unknown()).optional(),
  description: z.string().max(500).nullable().optional(),
  strategyPreset: z.enum(PRESET_KEYS).nullable().optional(),
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
      strategyPreset: parsed.data.preset,
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
    return reply.send({ blueprints: rows });
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
      strategyPreset: parsed.data.strategyPreset ?? null,
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
    return reply.send(bp);
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
      if (parsed.data.strategyPreset !== undefined) updateFields.strategyPreset = parsed.data.strategyPreset ?? null;
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
      strategyPreset: bp.strategyPreset,
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

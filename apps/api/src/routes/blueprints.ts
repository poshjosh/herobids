import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, or, sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { blueprints, bots } from '@herobids/db';
import { extractStrategyFromConfig, listPresets, getPreset, applyPresetToAgent } from '@herobids/domain';
import { deepMerge } from '../config.js';

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
  preset: z.string().min(1),
  style: z.enum(['economy', 'standard', 'premium']).default('standard'),
  name: z.string().min(1).max(120).optional(),
  overrides: z.record(z.unknown()).optional(),
});

const StyleQuerySchema = z.object({
  style: z.enum(['economy', 'standard', 'premium']).default('standard'),
});

const ForAgentQuerySchema = z.object({
  strategy: z.string().min(1),
  style: z.enum(['economy', 'standard', 'premium']).default('standard'),
  mode: z.enum(['llm', 'hybrid']).default('llm'),
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
  // GET /blueprints/presets — list available strategy presets for a style
  // Registered before /:id so Fastify doesn't swallow it as a param.
  app.get('/blueprints/presets', async (req, reply) => {
    const parsed = StyleQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }
    const presets = listPresets(parsed.data.style);
    return reply.send({ presets });
  });

  // GET /blueprints/defaults — default strategy/risk/execution from the standard momentum preset
  app.get('/blueprints/defaults', async (_request, reply) => {
    const defaultPreset = getPreset('momentum', 'standard');
    if (!defaultPreset) {
      return reply.status(500).send({ error: 'internal_error', message: 'Default preset not found' });
    }
    const defaults = {
      strategy: defaultPreset.strategy,
      risk: defaultPreset.risk ?? {},
      execution: defaultPreset.execution ?? { mode: 'paper' },
    };
    return reply.send({ defaults });
  });

  // POST /blueprints/from-preset — create a blueprint pre-populated from a YAML preset
  app.post<{ Body: unknown }>('/blueprints/from-preset', async (request, reply) => {
    const parsed = FromPresetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const preset = getPreset(parsed.data.preset, parsed.data.style);
    if (!preset) {
      return reply.status(404).send({
        error: 'preset_not_found',
        message: `Preset "${parsed.data.preset}" not found for style "${parsed.data.style}"`,
      });
    }

    // Convert PresetEntry to the configData format expected by blueprints
    const presetConfig = {
      strategy: preset.strategy,
      risk: preset.risk ?? {},
      execution: preset.execution ?? { mode: 'paper' },
    };

    const base = presetConfig as Record<string, unknown>;
    const rawOverrides = (parsed.data.overrides ?? {}) as Record<string, unknown>;
    const configData = Object.keys(rawOverrides).length > 0
      ? deepMerge(base, rawOverrides)
      : { ...base };
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

  // GET /presets/for-agent — return preset split into agent-consumable sections
  // Registered before /:id so Fastify doesn't swallow it as a param.
  app.get('/presets/for-agent', async (req, reply) => {
    const parsed = ForAgentQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }
    // Reject DCA at the API boundary — DCA is bot-only.
    if (parsed.data.strategy === 'dca') {
      return reply.status(400).send({
        error: 'preset_not_supported_for_agent',
        message: 'DCA is a bot-only strategy and cannot be applied to agents.',
      });
    }

    const preset = getPreset(parsed.data.strategy, parsed.data.style);
    if (!preset) {
      return reply.status(404).send({
        error: 'preset_not_found',
        message: `Preset "${parsed.data.strategy}" not found for style "${parsed.data.style}"`,
      });
    }
    const split = applyPresetToAgent(preset, parsed.data.mode);
    return reply.send(split);
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
        // Deep-merge with existing configData so that partial nested
        // overrides (e.g. strategy.params.candleLimit) add/override only
        // the specified leaf without discarding sibling keys.
        const existingConfig = bp.configData as Record<string, unknown>;
        const incoming = parsed.data.configData as Record<string, unknown>;
        updateFields.configData = deepMerge(existingConfig, incoming);
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

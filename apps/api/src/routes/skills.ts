import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, or, sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { findUnknownSkillTools } from '@herobids/domain';
import { skills } from '@herobids/db';

// --- Schemas ---

const CreateSkillSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  instructions: z.string().min(1).max(8000),
  requiredTools: z.array(z.string()).optional().default([]),
  contextRequirements: z.array(z.string()).optional().default([]),
  requiredGuardrails: z.array(z.string()).optional().default([]),
  visibility: z.enum(['private', 'public']).optional().default('private'),
  tags: z.array(z.string()).optional().default([]),
});

const UpdateSkillSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(1000).optional(),
  instructions: z.string().min(1).max(8000).optional(),
  requiredTools: z.array(z.string()).optional(),
  contextRequirements: z.array(z.string()).optional(),
  requiredGuardrails: z.array(z.string()).optional(),
  visibility: z.enum(['private', 'public']).optional(),
  tags: z.array(z.string()).optional(),
});

function buildUnknownToolValidationError(requiredTools: string[]) {
  const unknownTools = findUnknownSkillTools(requiredTools);
  if (unknownTools.length === 0) {
    return null;
  }

  return {
    error: 'validation_error',
    details: [{
      code: 'custom',
      path: ['requiredTools'],
      message: `Unknown requiredTools: ${unknownTools.join(', ')}`,
      params: {
        issueCode: 'skills.unknown_required_tools',
        unknownTools,
      },
    }],
  };
}

// --- Route module ---

export async function skillsRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET /skills — list own skills + public skills + built-in skills
  app.get('/skills', async (request, reply) => {
    // Return own skills + all public/built-in skills
    const rows = await db.select().from(skills)
      .where(or(
        eq(skills.authorId, request.userId),
        eq(skills.visibility, 'public'),
        eq(skills.visibility, 'built-in'),
        // legacy guard: authorId=null also means built-in regardless of visibility field
        sql`${skills.authorId} IS NULL`,
      ))
      .orderBy(skills.createdAt);

    return reply.send({ skills: rows });
  });

  // POST /skills — create a skill owned by the current user
  app.post<{ Body: unknown }>('/skills', async (request, reply) => {
    const parsed = CreateSkillSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const unknownToolError = buildUnknownToolValidationError(parsed.data.requiredTools);
    if (unknownToolError) {
      return reply.status(400).send(unknownToolError);
    }

    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(skills).values({
      id,
      authorId: request.userId,
      name: parsed.data.name,
      description: parsed.data.description,
      instructions: parsed.data.instructions,
      requiredTools: parsed.data.requiredTools,
      contextRequirements: parsed.data.contextRequirements,
      requiredGuardrails: parsed.data.requiredGuardrails,
      visibility: parsed.data.visibility,
      tags: parsed.data.tags,
      createdAt: now,
      updatedAt: now,
    });

    const [skill] = await db.select().from(skills).where(eq(skills.id, id));
    return reply.status(201).send(skill);
  });

  // GET /skills/:id — get a skill (own, public, or built-in)
  app.get<{ Params: { id: string } }>('/skills/:id', async (request, reply) => {
    const { id } = request.params;
    const [skill] = await db.select().from(skills)
      .where(and(
        eq(skills.id, id),
        or(
          eq(skills.authorId, request.userId),
          eq(skills.visibility, 'public'),
          sql`${skills.authorId} IS NULL`,
        ),
      ));

    if (!skill) return reply.status(404).send({ error: 'not_found' });
    return reply.send(skill);
  });

  // PUT /skills/:id — full update of own skill
  app.put<{ Params: { id: string }; Body: unknown }>('/skills/:id', async (request, reply) => {
    const { id } = request.params;
    const parsed = UpdateSkillSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    if (parsed.data.requiredTools) {
      const unknownToolError = buildUnknownToolValidationError(parsed.data.requiredTools);
      if (unknownToolError) {
        return reply.status(400).send(unknownToolError);
      }
    }

    const [skill] = await db.select().from(skills)
      .where(and(eq(skills.id, id), eq(skills.authorId, request.userId)));
    if (!skill) return reply.status(404).send({ error: 'not_found' });

    // Built-in skills (authorId = null) cannot be updated — already guarded by ownership check above

    await db.update(skills).set({ ...parsed.data, updatedAt: new Date() }).where(eq(skills.id, id));
    const [updated] = await db.select().from(skills).where(eq(skills.id, id));
    return reply.send(updated);
  });

  // DELETE /skills/:id — delete own skill
  app.delete<{ Params: { id: string } }>('/skills/:id', async (request, reply) => {
    const { id } = request.params;
    const [skill] = await db.select({ id: skills.id, authorId: skills.authorId }).from(skills)
      .where(and(eq(skills.id, id), eq(skills.authorId, request.userId)));
    if (!skill) return reply.status(404).send({ error: 'not_found' });

    await db.delete(skills).where(eq(skills.id, id));
    return reply.status(204).send();
  });

  // POST /skills/:id/fork — create a private copy owned by the caller
  app.post<{ Params: { id: string } }>('/skills/:id/fork', async (request, reply) => {
    const { id } = request.params;
    // Can fork own, public, or built-in skills
    const [source] = await db.select().from(skills)
      .where(and(
        eq(skills.id, id),
        or(
          eq(skills.authorId, request.userId),
          eq(skills.visibility, 'public'),
          sql`${skills.authorId} IS NULL`,
        ),
      ));
    if (!source) return reply.status(404).send({ error: 'not_found' });

    const unknownToolError = buildUnknownToolValidationError(source.requiredTools);
    if (unknownToolError) {
      return reply.status(400).send(unknownToolError);
    }

    const newId = crypto.randomUUID();
    const now = new Date();
    await db.insert(skills).values({
      id: newId,
      authorId: request.userId,
      name: `${source.name} (fork)`,
      description: source.description,
      instructions: source.instructions,
      requiredTools: source.requiredTools,
      contextRequirements: source.contextRequirements,
      requiredGuardrails: source.requiredGuardrails,
      visibility: 'private',
      tags: source.tags ?? [],
      forkOf: source.id,
      createdAt: now,
      updatedAt: now,
    });

    const [forked] = await db.select().from(skills).where(eq(skills.id, newId));
    return reply.status(201).send(forked);
  });
}

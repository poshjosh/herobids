import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { credentials } from '@herobids/db';
import { encryptCredential, getEncryptionKey } from '../crypto.js';
import { CreateCredentialSchema, RotateCredentialSchema } from '../schemas.js';

export async function credentialRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // Create credential
  app.post('/credentials', async (request, reply) => {
    const parsed = CreateCredentialSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const encryptionKey = getEncryptionKey();
    const id = crypto.randomUUID();
    const now = new Date();

    // Encrypt the secrets blob
    const secretsJson = JSON.stringify(parsed.data.secrets);
    const { encryptedData, encryptionMeta } = encryptCredential(secretsJson, encryptionKey);

    await db.insert(credentials).values({
      id,
      userId: parsed.data.userId,
      venue: parsed.data.venue,
      label: parsed.data.label,
      encryptedData,
      encryptionMeta,
      createdAt: now,
      updatedAt: now,
    });

    // Return without secrets
    return reply.status(201).send({
      id,
      userId: parsed.data.userId,
      venue: parsed.data.venue,
      label: parsed.data.label,
      createdAt: now,
      updatedAt: now,
    });
  });

  // List credentials (metadata only, no secrets)
  app.get('/credentials', async (_request, reply) => {
    const rows = await db
      .select({
        id: credentials.id,
        userId: credentials.userId,
        venue: credentials.venue,
        label: credentials.label,
        createdAt: credentials.createdAt,
        updatedAt: credentials.updatedAt,
      })
      .from(credentials);
    return reply.send({ credentials: rows });
  });

  // Get single credential (metadata only)
  app.get<{ Params: { id: string } }>('/credentials/:id', async (request, reply) => {
    const { id } = request.params;
    const [row] = await db
      .select({
        id: credentials.id,
        userId: credentials.userId,
        venue: credentials.venue,
        label: credentials.label,
        createdAt: credentials.createdAt,
        updatedAt: credentials.updatedAt,
      })
      .from(credentials)
      .where(eq(credentials.id, id));

    if (!row) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.send(row);
  });

  // Rotate credential (re-encrypt with new secrets)
  app.post<{ Params: { id: string } }>('/credentials/:id/rotate', async (request, reply) => {
    const { id } = request.params;
    const parsed = RotateCredentialSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const [existing] = await db.select({ id: credentials.id }).from(credentials).where(eq(credentials.id, id));
    if (!existing) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const encryptionKey = getEncryptionKey();
    const secretsJson = JSON.stringify(parsed.data.secrets);
    const { encryptedData, encryptionMeta } = encryptCredential(secretsJson, encryptionKey);

    await db.update(credentials)
      .set({ encryptedData, encryptionMeta, updatedAt: new Date() })
      .where(eq(credentials.id, id));

    return reply.send({ status: 'rotated', credentialId: id });
  });

  // Delete credential
  app.delete<{ Params: { id: string } }>('/credentials/:id', async (request, reply) => {
    const { id } = request.params;

    const [existing] = await db.select({ id: credentials.id }).from(credentials).where(eq(credentials.id, id));
    if (!existing) {
      return reply.status(404).send({ error: 'not_found' });
    }

    await db.delete(credentials).where(eq(credentials.id, id));
    return reply.send({ status: 'deleted', credentialId: id });
  });
}

import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type { Database } from '@herobids/db';
import { credentials, PgJournal } from '@herobids/db';
import { credentialCreatedEvent, credentialRotatedEvent, credentialDeletedEvent } from '@herobids/engine';
import { encryptCredential, getEncryptionKey } from '../crypto.js';
import { CreateCredentialSchema, RotateCredentialSchema } from '../schemas.js';
import { findCredentialDependents } from '../credential-dependents.js';
import type { LifecycleJob } from '../types.js';

/** Best-effort audit append — never fails the HTTP request if the mutation already succeeded */
function auditAppend(journal: InstanceType<typeof PgJournal>, entry: Parameters<InstanceType<typeof PgJournal>['append']>[0], log: { error: (obj: unknown, msg: string) => void }): void {
  journal.append(entry).catch((err) => {
    log.error({ err, eventType: entry.type }, 'Failed to persist credential audit event');
  });
}

interface SecretValidationError {
  field: string;
  message: string;
}

/** Venue-specific validation of credential secrets. Returns empty array if valid. */
function validateVenueSecrets(venue: string, secrets: Record<string, string>): SecretValidationError[] {
  const errors: SecretValidationError[] = [];

  if (venue === 'hyperliquid') {
    if (!secrets['apiKey']?.trim()) {
      errors.push({ field: 'secrets.apiKey', message: 'apiKey is required for Hyperliquid credentials' });
    }
    if (!secrets['secret']?.trim()) {
      errors.push({ field: 'secrets.secret', message: 'secret is required for Hyperliquid credentials' });
    }
    if (!secrets['walletAddress']?.trim()) {
      errors.push({ field: 'secrets.walletAddress', message: 'walletAddress is required for Hyperliquid credentials' });
    } else if (!/^0x[0-9a-fA-F]{40}$/.test(secrets['walletAddress'])) {
      errors.push({ field: 'secrets.walletAddress', message: 'walletAddress must be a valid EVM address (0x + 40 hex chars)' });
    }
  }

  return errors;
}

export async function credentialRoutes(app: FastifyInstance, queue: Queue<LifecycleJob>, db: Database): Promise<void> {
  const journal = new PgJournal(db);

  // Create credential
  app.post('/credentials', async (request, reply) => {
    const parsed = CreateCredentialSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Venue-specific secret validation — fail fast on incomplete credentials
    const venueSecretErrors = validateVenueSecrets(parsed.data.venue, parsed.data.secrets);
    if (venueSecretErrors.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: venueSecretErrors });
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

    auditAppend(journal, credentialCreatedEvent({
      credentialId: id,
      venue: parsed.data.venue,
      userId: parsed.data.userId,
      label: parsed.data.label,
    }), app.log);

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

    const [existing] = await db.select({ id: credentials.id, venue: credentials.venue, userId: credentials.userId }).from(credentials).where(eq(credentials.id, id));
    if (!existing) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Venue-specific secret validation — fail fast on incomplete credentials
    const venueSecretErrors = validateVenueSecrets(existing.venue, parsed.data.secrets);
    if (venueSecretErrors.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: venueSecretErrors });
    }

    const encryptionKey = getEncryptionKey();
    const secretsJson = JSON.stringify(parsed.data.secrets);
    const { encryptedData, encryptionMeta } = encryptCredential(secretsJson, encryptionKey);

    await db.update(credentials)
      .set({ encryptedData, encryptionMeta, updatedAt: new Date() })
      .where(eq(credentials.id, id));

    auditAppend(journal, credentialRotatedEvent({
      credentialId: id,
      venue: existing.venue,
      userId: existing.userId,
    }), app.log);

    // Best-effort restart of running dependents — rotation already succeeded above,
    // so failures here must not mask the successful update.
    let runningInstanceIds: string[] = [];
    let restartedIds: string[] = [];
    let restartError: string | undefined;
    let restartErrorCode: 'lookup_failed' | 'enqueue_failed' | undefined;
    try {
      const deps = await findCredentialDependents(db, id);
      runningInstanceIds = deps.runningInstanceIds;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      restartErrorCode = 'lookup_failed';
      restartError = `Failed to determine dependent instances: ${msg}`;
      app.log.error({ err, credentialId: id }, 'Failed to look up credential dependents after rotation');
    }
    try {
      for (const instanceId of runningInstanceIds) {
        await queue.add('restart-instance', {
          command: 'restart',
          tradingInstanceId: instanceId,
        });
        restartedIds.push(instanceId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      restartErrorCode = 'enqueue_failed';
      restartError = `Failed to enqueue all restart jobs: ${msg}`;
      app.log.error({ err, credentialId: id, restartedIds, runningInstanceIds }, 'Failed to enqueue restart jobs after credential rotation');
    }

    return reply.send({
      status: 'rotated',
      credentialId: id,
      dependentTradingInstanceIds: runningInstanceIds,
      restartedTradingInstanceIds: restartedIds,
      ...(restartError ? { restartErrorCode, restartError } : {}),
    });
  });

  // Delete credential — fail-closed: reject if any venue accounts still reference it
  app.delete<{ Params: { id: string } }>('/credentials/:id', async (request, reply) => {
    const { id } = request.params;

    const [existing] = await db.select({ id: credentials.id, venue: credentials.venue, userId: credentials.userId }).from(credentials).where(eq(credentials.id, id));
    if (!existing) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Check for dependents — block delete if any venue accounts still link to this credential
    const { venueAccountIds, runningInstanceIds } = await findCredentialDependents(db, id);
    if (venueAccountIds.length > 0) {
      return reply.status(409).send({
        error: 'credential_in_use',
        credentialId: id,
        blockingVenueAccountIds: venueAccountIds,
        blockingTradingInstanceIds: runningInstanceIds,
      });
    }

    try {
      await db.delete(credentials).where(eq(credentials.id, id));
    } catch (err: unknown) {
      // FK violation (concurrent link between pre-check and delete) → translate to 409
      const pgErr = err as { code?: string };
      if (pgErr.code === '23503') {
        const deps = await findCredentialDependents(db, id);
        return reply.status(409).send({
          error: 'credential_in_use',
          credentialId: id,
          blockingVenueAccountIds: deps.venueAccountIds,
          blockingTradingInstanceIds: deps.runningInstanceIds,
        });
      }
      throw err;
    }

    auditAppend(journal, credentialDeletedEvent({
      credentialId: id,
      venue: existing.venue,
      userId: existing.userId,
    }), app.log);

    return reply.send({ status: 'deleted', credentialId: id });
  });
}

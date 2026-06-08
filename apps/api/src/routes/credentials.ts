import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type { Database } from '@herobids/db';
import { userCredentials, PgJournal } from '@herobids/db';
import { credentialCreatedEvent, credentialRotatedEvent, credentialDeletedEvent } from '@herobids/engine';
import type { PlansConfig } from '@herobids/domain';
import { encryptCredential, getEncryptionKey } from '../crypto.js';
import { CreateCredentialSchema, RotateCredentialSchema } from '../schemas.js';
import { findCredentialDependents } from '../credential-dependents.js';
import { checkCredentialLimit } from '../plan-guards.js';
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

const SECRET_ALIASES_BY_VENUE: Record<string, Record<string, string[]>> = {
  hyperliquid: {
    apiKey: ['apikey'],
    secret: ['secret', 'secretkey'],
    walletAddress: ['walletaddress', 'accountaddress'],
  },
  bybit: {
    apiKey: ['apikey'],
    secret: ['secret', 'secretkey'],
  },
  '1inch': {
    apiKey: ['apikey'],
    privateKey: ['privatekey'],
  },
};

function normalizeSecretToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function canonicalizeVenueSecrets(venue: string, secrets: Record<string, string>): Record<string, string> {
  const aliases = SECRET_ALIASES_BY_VENUE[venue] ?? {};
  const canonicalSecrets: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(secrets)) {
    const trimmedKey = rawKey.trim();
    if (!trimmedKey) {
      continue;
    }

    const normalizedKey = normalizeSecretToken(trimmedKey);
    const canonicalKey = Object.entries(aliases).find(([, knownAliases]) => knownAliases.includes(normalizedKey))?.[0] ?? trimmedKey;
    canonicalSecrets[canonicalKey] = rawValue.trim();
  }

  return canonicalSecrets;
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
  } else if (venue === 'bybit') {
    if (!secrets['apiKey']?.trim()) {
      errors.push({ field: 'secrets.apiKey', message: 'apiKey is required for Bybit credentials' });
    }
    if (!secrets['secret']?.trim()) {
      errors.push({ field: 'secrets.secret', message: 'secret is required for Bybit credentials' });
    }
  } else if (venue === '1inch') {
    const pk = secrets['privateKey']?.trim() ?? '';
    if (!pk) {
      errors.push({ field: 'secrets.privateKey', message: 'privateKey is required for 1inch credentials' });
    } else if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) {
      errors.push({ field: 'secrets.privateKey', message: 'privateKey must be 64 hex chars (optionally 0x-prefixed)' });
    }
    if (!secrets['apiKey']?.trim()) {
      errors.push({ field: 'secrets.apiKey', message: 'apiKey (1inch developer portal key) is required for 1inch credentials' });
    }
  }

  return errors;
}

export async function credentialRoutes(app: FastifyInstance, queue: Queue<LifecycleJob>, db: Database, plansConfig?: PlansConfig): Promise<void> {
  const journal = new PgJournal(db);

  // Create credential
  app.post('/credentials', async (request, reply) => {
    const parsed = CreateCredentialSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const normalizedSecrets = canonicalizeVenueSecrets(parsed.data.venue, parsed.data.secrets);

    // Venue-specific secret validation — fail fast on incomplete credentials
    const venueSecretErrors = validateVenueSecrets(parsed.data.venue, normalizedSecrets);
    if (venueSecretErrors.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: venueSecretErrors });
    }

    // Plan enforcement
    if (plansConfig) {
      const planCheck = await checkCredentialLimit(db, plansConfig, request.userId, request.userPlanId || 'free');
      if (!planCheck.ok) {
        return reply.status(403).send({ error: planCheck.error.code, message: planCheck.error.message });
      }
    }

    const encryptionKey = getEncryptionKey();
    const id = crypto.randomUUID();
    const now = new Date();

    // Encrypt the secrets blob
    const secretsJson = JSON.stringify(normalizedSecrets);
    const { encryptedData, encryptionMeta } = encryptCredential(secretsJson, encryptionKey);

    await db.insert(userCredentials).values({
      id,
      userId: request.userId,
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
      userId: request.userId,
      label: parsed.data.label,
    }), app.log);

    // Return without secrets
    return reply.status(201).send({
      id,
      userId: request.userId,
      venue: parsed.data.venue,
      label: parsed.data.label,
      createdAt: now,
      updatedAt: now,
    });
  });

  // List credentials (metadata only, no secrets)
  app.get('/credentials', async (request, reply) => {
    const rows = await db
      .select({
        id: userCredentials.id,
        userId: userCredentials.userId,
        venue: userCredentials.venue,
        label: userCredentials.label,
        createdAt: userCredentials.createdAt,
        updatedAt: userCredentials.updatedAt,
      })
      .from(userCredentials)
      .where(eq(userCredentials.userId, request.userId));
    return reply.send({ credentials: rows });
  });

  // Get single credential (metadata only)
  app.get<{ Params: { id: string } }>('/credentials/:id', async (request, reply) => {
    const { id } = request.params;
    const [row] = await db
      .select({
        id: userCredentials.id,
        userId: userCredentials.userId,
        venue: userCredentials.venue,
        label: userCredentials.label,
        createdAt: userCredentials.createdAt,
        updatedAt: userCredentials.updatedAt,
      })
      .from(userCredentials)
      .where(and(eq(userCredentials.id, id), eq(userCredentials.userId, request.userId)));

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

    const [existing] = await db.select({ id: userCredentials.id, venue: userCredentials.venue, userId: userCredentials.userId }).from(userCredentials).where(and(eq(userCredentials.id, id), eq(userCredentials.userId, request.userId)));
    if (!existing) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const normalizedSecrets = canonicalizeVenueSecrets(existing.venue, parsed.data.secrets);

    // Venue-specific secret validation — fail fast on incomplete credentials
    const venueSecretErrors = validateVenueSecrets(existing.venue, normalizedSecrets);
    if (venueSecretErrors.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: venueSecretErrors });
    }

    const encryptionKey = getEncryptionKey();
    const secretsJson = JSON.stringify(normalizedSecrets);
    const { encryptedData, encryptionMeta } = encryptCredential(secretsJson, encryptionKey);

    await db.update(userCredentials)
      .set({ encryptedData, encryptionMeta, updatedAt: new Date() })
      .where(eq(userCredentials.id, id));

    auditAppend(journal, credentialRotatedEvent({
      credentialId: id,
      venue: existing.venue,
      userId: request.userId,
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
          botId: instanceId,
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
      dependentBotIds: runningInstanceIds,
      restartedBotIds: restartedIds,
      ...(restartError ? { restartErrorCode, restartError } : {}),
    });
  });

  // Delete credential — fail-closed: reject if any venue accounts still reference it
  app.delete<{ Params: { id: string } }>('/credentials/:id', async (request, reply) => {
    const { id } = request.params;

    const [existing] = await db.select({ id: userCredentials.id, venue: userCredentials.venue, userId: userCredentials.userId }).from(userCredentials).where(and(eq(userCredentials.id, id), eq(userCredentials.userId, request.userId)));
    if (!existing) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Check for dependents — block delete if active venue accounts or active connections link to this credential.
    // Revoked connections are handled by ON DELETE SET NULL; only active ones block deletion.
    const { venueAccountIds, runningInstanceIds, activeConnectionIds } = await findCredentialDependents(db, id);
    if (venueAccountIds.length > 0 || activeConnectionIds.length > 0) {
      return reply.status(409).send({
        error: 'credential_in_use',
        credentialId: id,
        blockingVenueAccountIds: venueAccountIds,
        blockingBotIds: runningInstanceIds,
        blockingConnectionIds: activeConnectionIds,
      });
    }

    try {
      await db.delete(userCredentials).where(eq(userCredentials.id, id));
    } catch (err: unknown) {
      // FK violation (concurrent link between pre-check and delete) → translate to 409
      const pgErr = err as { code?: string };
      if (pgErr.code === '23503') {
        const deps = await findCredentialDependents(db, id);
        return reply.status(409).send({
          error: 'credential_in_use',
          credentialId: id,
          blockingVenueAccountIds: deps.venueAccountIds,
          blockingBotIds: deps.runningInstanceIds,
          blockingConnectionIds: deps.activeConnectionIds,
        });
      }
      throw err;
    }

    auditAppend(journal, credentialDeletedEvent({
      credentialId: id,
      venue: existing.venue,
      userId: request.userId,
    }), app.log);

    return reply.send({ status: 'deleted', credentialId: id });
  });
}

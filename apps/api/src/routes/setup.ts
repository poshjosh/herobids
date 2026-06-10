import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import type { Database } from '@herobids/db';
import { userCredentials, connections } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import { encryptCredential, getEncryptionKey } from '../crypto.js';
import { canonicalizeVenueSecrets, validateVenueSecrets } from './credentials.js';
import { provisionTradingTarget } from '../trading-provisioner.js';
import { checkCredentialLimit, checkVenueAccountLimit } from '../plan-guards.js';
import { SetupProviderLinkSchema } from '../schemas.js';
import { errorPayload, type ApiErrorDetail } from '../error-payload.js';

const SUPPORTED_TRADING_PROVIDERS = new Set(['hyperliquid', 'jupiter', '1inch', 'bybit']);

function credentialValidationPayload(errors: ReturnType<typeof validateVenueSecrets>) {
  const primary = errors[0]!;
  return errorPayload(primary.code, primary.message, primary.params, {
    details: errors.map<ApiErrorDetail>(({ field, code, message, params }) => ({ field, code, message, params })),
  });
}

export async function setupRoutes(
  app: FastifyInstance,
  db: Database,
  plansConfig?: PlansConfig,
): Promise<void> {
  /**
   * POST /setup/provider-link
   *
   * Guided setup flow: creates a credential, a connection, and — when
   * capability = "trading" — a companion venue account + trading binding,
   * all in a single transaction.
   *
   * This is the preferred path for Mission Control and Create Agent. The
   * primitive /credentials and /connections endpoints remain available as
   * advanced / manual-operator tools.
   */
  app.post('/setup/provider-link', async (request, reply) => {
    const parsed = SetupProviderLinkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const { provider, label, secrets, capability } = parsed.data;

    if (capability === 'trading' && !SUPPORTED_TRADING_PROVIDERS.has(provider)) {
      return reply.status(400).send(
        errorPayload(
          'capability.unsupported_provider',
          `Provider ${provider} is not supported for trading setup.`,
          { provider, capability },
        ),
      );
    }

    const normalizedSecrets = canonicalizeVenueSecrets(provider, secrets);

    const venueErrors = validateVenueSecrets(provider, normalizedSecrets);
    if (venueErrors.length > 0) {
      return reply.status(400).send(credentialValidationPayload(venueErrors));
    }

    if (plansConfig) {
      const credentialCheck = await checkCredentialLimit(db, plansConfig, request.userId, request.userPlanId || 'free');
      if (!credentialCheck.ok) {
        return reply.status(403).send(
          errorPayload(credentialCheck.error.code, credentialCheck.error.message, credentialCheck.error.params),
        );
      }

      if (capability === 'trading') {
        const venueAccountCheck = await checkVenueAccountLimit(db, plansConfig, request.userId, request.userPlanId || 'free');
        if (!venueAccountCheck.ok) {
          return reply.status(403).send(
            errorPayload(venueAccountCheck.error.code, venueAccountCheck.error.message, venueAccountCheck.error.params),
          );
        }
      }
    }

    const encryptionKey = getEncryptionKey();
    const credentialId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const now = new Date();

    const secretsJson = JSON.stringify(normalizedSecrets);
    const { encryptedData, encryptionMeta } = encryptCredential(secretsJson, encryptionKey);

    let tradingResult: { venueAccountId: string; bindingId: string } | null = null;

    await db.transaction(async (tx) => {
      await tx.insert(userCredentials).values({
        id: credentialId,
        userId: request.userId,
        venue: provider,
        label,
        encryptedData,
        encryptionMeta,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(connections).values({
        id: connectionId,
        userId: request.userId,
        credentialId,
        provider,
        label,
        status: 'active',
        meta: null,
        createdAt: now,
        updatedAt: now,
      });

      if (capability === 'trading') {
        tradingResult = await provisionTradingTarget(tx, {
          userId: request.userId,
          connectionId,
          provider,
          label,
          credentialId,
          now,
        });
      }
    });

    const response: Record<string, unknown> = {
      credential: {
        id: credentialId,
        venue: provider,
        label,
        createdAt: now,
      },
      connection: {
        id: connectionId,
        provider,
        label,
        status: 'active',
        credentialId,
        createdAt: now,
      },
    };

    if (tradingResult !== null) {
      const { venueAccountId, bindingId } = tradingResult as { venueAccountId: string; bindingId: string };
      response['venueAccount'] = {
        id: venueAccountId,
        venue: provider,
        label,
        credentialId,
        createdAt: now,
      };
      response['tradingBinding'] = {
        id: bindingId,
        connectionId,
        provider,
        label,
        sourceVenueAccountId: venueAccountId,
        status: 'active',
        createdAt: now,
      };
    }

    return reply.status(201).send(response);
  });
}

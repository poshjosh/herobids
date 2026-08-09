import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { userCredentials, connections } from '@herobids/db';
import type { AppConfig, PlansConfig } from '@herobids/domain';
import { generateWallet, deriveSolanaAddress } from '@herobids/venues';
import type { WalletGenerationRequest, WalletGenerationResult } from '@herobids/venues';
import { encryptCredential, getEncryptionKey } from '../crypto.js';
import { canonicalizeVenueSecrets, validateVenueSecrets } from './credentials.js';
import { provisionTradingTarget } from '../trading-provisioner.js';
import { checkConnectionLimit, checkCredentialLimit, checkVenueAccountLimit } from '../plan-guards.js';
import { SetupProviderLinkSchema } from '../schemas.js';
import { errorPayload, type ApiErrorDetail } from '../error-payload.js';
import { getProviderWalletGenerationCapability, providerAllowsTradingSetup } from '../providers/registry.js';
import { deleteProviderLink } from '../provider-links.js';

function credentialValidationPayload(errors: ReturnType<typeof validateVenueSecrets>) {
  const primary = errors[0]!;
  return errorPayload(primary.code, primary.message, primary.params, {
    details: errors.map<ApiErrorDetail>(({ field, code, message, params }) => ({ field, code, message, params })),
  });
}

export interface SetupRouteDeps {
  venues: AppConfig['venues'];
  generateWallet: (request: WalletGenerationRequest) => WalletGenerationResult;
}

export interface CreateProviderLinkInput {
  userId: string;
  userPlanId?: string;
  isAdmin?: boolean;
  provider: string;
  label: string;
  capability?: 'trading';
  credentialMode: 'manual' | 'generated';
  secrets?: Record<string, string>;
}

export type CreateProviderLinkResult =
  | { kind: 'ok'; credentialId: string; connectionId: string; provider: string; label: string; venueAccountId: string | null; wallet: WalletGenerationResult['wallet'] | null }
  | { kind: 'limit'; error: { code: string; message: string; params?: Record<string, unknown> } }
  | { kind: 'validation'; errors: ReturnType<typeof validateVenueSecrets> }
  | { kind: 'error'; code: string; message: string; params?: Record<string, unknown> }
  | { kind: 'fault'; code: string; message: string; params?: Record<string, unknown> };

/**
 * Shared provider-link creation logic used by both the HTTP route and the
 * Guided Setup `create_connection` chat tool. Creates a credential, a
 * connection, and — when capability = "trading" — a companion venue account
 * (writing resolvedVenueAccountId), all in a single transaction.
 */
export async function createProviderLink(
  db: Database,
  plansConfig: PlansConfig | undefined,
  deps: SetupRouteDeps,
  input: CreateProviderLinkInput,
): Promise<CreateProviderLinkResult> {
  const { userId, userPlanId, isAdmin, provider, label, capability, credentialMode, secrets } = input;
  const planId = userPlanId || 'free';
  const admin = isAdmin ?? false;

  if (capability === 'trading' && !providerAllowsTradingSetup(provider)) {
    return {
      kind: 'error',
      code: 'capability.unsupported_provider',
      message: `Provider ${provider} is not supported for trading setup.`,
      params: { provider, capability },
    };
  }

  const walletCapability = credentialMode === 'generated'
    ? getProviderWalletGenerationCapability(provider, deps.venues)
    : undefined;
  if (credentialMode === 'generated') {
    if (!walletCapability) {
      return {
        kind: 'error',
        code: 'wallet_generation.unsupported_provider',
        message: `Provider ${provider} does not support generated wallets.`,
        params: { provider },
      };
    }
    if (!walletCapability.available) {
      return {
        kind: 'error',
        code: 'wallet_generation.disabled',
        message: `Generated wallets are not currently available for provider ${provider}.`,
        params: { provider },
      };
    }
  }

  const manualSecrets = credentialMode === 'manual'
    ? canonicalizeVenueSecrets(provider, secrets ?? {})
    : undefined;
  if (manualSecrets) {
    const venueErrors = validateVenueSecrets(provider, manualSecrets);
    if (venueErrors.length > 0) {
      return { kind: 'validation', errors: venueErrors };
    }
  }

  const encryptionKey = getEncryptionKey();
  const credentialId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const now = new Date();

  let txResult: {
    kind: 'limit';
    error: { code: string; message: string; params?: Record<string, unknown> };
  } | {
    kind: 'validation';
    errors: ReturnType<typeof validateVenueSecrets>;
  } | {
    kind: 'ok';
    tradingResult: { venueAccountId: string } | null;
    wallet: WalletGenerationResult['wallet'] | null;
  };
  try {
    txResult = await db.transaction(async (tx) => {
      if (plansConfig) {
        // Serialise setup quota checks per user to avoid over-limit races.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(14, hashtext(${userId}))`);

        const credentialCheck = await checkCredentialLimit(tx as unknown as Database, plansConfig, userId, planId, admin);
        if (!credentialCheck.ok) {
          return { kind: 'limit' as const, error: credentialCheck.error };
        }

        const connectionCheck = await checkConnectionLimit(tx as unknown as Database, plansConfig, userId, planId, admin);
        if (!connectionCheck.ok) {
          return { kind: 'limit' as const, error: connectionCheck.error };
        }

        if (capability === 'trading') {
          const venueAccountCheck = await checkVenueAccountLimit(tx as unknown as Database, plansConfig, userId, planId, admin);
          if (!venueAccountCheck.ok) {
            return { kind: 'limit' as const, error: venueAccountCheck.error };
          }
        }
      }

      const generated = credentialMode === 'generated'
        ? deps.generateWallet({ provider, enabled: walletCapability!.available, network: walletCapability!.network })
        : undefined;
      const normalizedSecrets = generated
        ? canonicalizeVenueSecrets(provider, generated.secrets)
        : manualSecrets!;
      const venueErrors = validateVenueSecrets(provider, normalizedSecrets);
      if (venueErrors.length > 0) {
        return { kind: 'validation' as const, errors: venueErrors };
      }
      const { encryptedData, encryptionMeta } = encryptCredential(JSON.stringify(normalizedSecrets), encryptionKey);

      await tx.insert(userCredentials).values({
        id: credentialId,
        userId,
        provider,
        label,
        encryptedData,
        encryptionMeta,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(connections).values({
        id: connectionId,
        userId,
        credentialId,
        provider,
        label,
        status: 'active',
        meta: null,
        createdAt: now,
        updatedAt: now,
      });

      let tradingResult: { venueAccountId: string } | null = null;
      if (capability === 'trading') {
        // Resolve venueAccountRef:
        // - generated wallet → use the generated address
        // - manual Hyperliquid → walletAddress from secrets
        // - manual Jupiter → derive Solana address from private key
        // - other manual → null (venue-specific resolution downstream)
        const resolvedVenueAccountRef: string | null = generated?.wallet.address
          ?? (provider === 'hyperliquid' ? normalizedSecrets['walletAddress'] ?? null : null)
          ?? (provider === 'jupiter' && normalizedSecrets['privateKey']
            ? deriveSolanaAddress(normalizedSecrets['privateKey'])
            : null);

        tradingResult = await provisionTradingTarget(tx, {
          userId,
          connectionId,
          provider,
          label,
          credentialId,
          venueAccountRef: resolvedVenueAccountRef,
          now,
        });
      }

      return { kind: 'ok' as const, tradingResult, wallet: generated?.wallet ?? null };
    });
  } catch (err) {
    console.error('createProviderLink: unexpected error', { err, provider, credentialMode, userId });
    return {
      kind: 'fault',
      code: 'setup.provider_link_failed',
      message: 'Failed to set up provider connection. Please try again.',
      params: { provider, credentialMode },
    };
  }

  if (txResult.kind === 'limit') {
    return { kind: 'limit', error: txResult.error };
  }
  if (txResult.kind === 'validation') {
    return { kind: 'validation', errors: txResult.errors };
  }

  return {
    kind: 'ok',
    credentialId,
    connectionId,
    provider,
    label,
    venueAccountId: txResult.tradingResult?.venueAccountId ?? null,
    wallet: txResult.wallet,
  };
}

export async function setupRoutes(
  app: FastifyInstance,
  db: Database,
  plansConfig?: PlansConfig,
  deps: SetupRouteDeps = { venues: {}, generateWallet },
): Promise<void> {
  /**
   * POST /setup/provider-link
   *
   * Guided setup flow: creates a credential, a connection, and — when
   * capability = "trading" — a companion venue account and writes
   * resolvedVenueAccountId on the connection, all in a single transaction.
   *
  * This is the preferred path for Mission Control and Create AI Agent. The
   * primitive /credentials and /connections endpoints remain available as
   * advanced / manual-operator tools.
   */
  app.post('/setup/provider-link', async (request, reply) => {
    const parsed = SetupProviderLinkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const { provider, label, capability, credentialMode, secrets } = parsed.data;
    const now = new Date();

    const result = await createProviderLink(db, plansConfig, deps, {
      userId: request.userId,
      userPlanId: request.userPlanId || 'free',
      isAdmin: request.isAdmin,
      provider,
      label,
      capability,
      credentialMode,
      secrets,
    });

    if (result.kind === 'ok') {
      const response: Record<string, unknown> = {
        credential: {
          id: result.credentialId,
          provider: result.provider,
          label: result.label,
          createdAt: now,
        },
        connection: {
          id: result.connectionId,
          provider: result.provider,
          label: result.label,
          status: 'active',
          credentialId: result.credentialId,
          resolvedVenueAccountId: result.venueAccountId,
          createdAt: now,
        },
      };

      if (result.venueAccountId) {
        response.venueAccount = {
          id: result.venueAccountId,
          venue: result.provider,
          label: result.label,
          createdAt: now,
        };
      }

      if (result.wallet && walletCapabilityFor(result.provider, credentialMode, deps)) {
        response.wallet = {
          address: result.wallet.address,
          network: result.wallet.network,
          fundingInstructionId: walletCapabilityFor(result.provider, credentialMode, deps)!.fundingInstructionId,
          custodyMode: 'direct',
        };
      }

      return reply.status(201).send(response);
    }

    if (result.kind === 'limit') {
      return reply.status(403).send(
        errorPayload(result.error.code, result.error.message, result.error.params),
      );
    }
    if (result.kind === 'validation') {
      return reply.status(400).send(credentialValidationPayload(result.errors));
    }
    if (result.kind === 'fault') {
      return reply.status(500).send(
        errorPayload(result.code, result.message, result.params),
      );
    }
    return reply.status(400).send(
      errorPayload(result.code, result.message, result.params),
    );
  });

  /**
   * DELETE /setup/provider-link/:connectionId
   *
   * Cascade-deletes a guided trading provider link: connection, linked venue
   * account, and linked credential in one transaction. Only eligible for
   * connections with `resolvedVenueAccountId !== null`.
   */
  app.delete<{ Params: { connectionId: string } }>(
    '/setup/provider-link/:connectionId',
    async (request, reply) => {
      const { connectionId } = request.params;

      try {
        const result = await deleteProviderLink(db, connectionId, request.userId);

        if (result.kind === 'ok') {
          return reply.status(200).send({
            status: 'deleted',
            connectionId: result.connectionId,
            deleted: result.deleted,
          });
        }

        if (result.kind === 'not_found') {
          return reply.status(404).send(
            errorPayload('not_found', 'Connection not found'),
          );
        }

        if (result.kind === 'not_eligible') {
          return reply.status(400).send(
            errorPayload(
              'provider_link.not_eligible',
              'This connection is not a guided trading link. Use DELETE /connections/:id?permanent=true to delete the connection only.',
              { connectionId: result.connectionId },
            ),
          );
        }

        if (result.kind === 'blocked') {
          return reply.status(409).send({
            error: 'provider_link.in_use',
            params: {
              connectionId: result.connectionId,
              blockingAgentIds: result.blockingAgentIds,
              blockingConnectionBotIds: result.blockingConnectionBotIds,
              blockingVenueAccountBotIds: result.blockingVenueAccountBotIds,
              hint:
                'Remove agent grants and bots before deleting the linked wallet data.',
            },
          });
        }

        if (result.kind === 'fault') {
          return reply.status(500).send(
            errorPayload(result.code, result.message),
          );
        }
      } catch (err) {
        app.log.error({ err, connectionId }, 'Unhandled error in provider-link cascade delete');
        return reply.status(500).send(
          errorPayload('internal_error', 'An unexpected error occurred while deleting the provider link.'),
        );
      }
    },
  );
}

function walletCapabilityFor(provider: string, credentialMode: 'manual' | 'generated', deps: SetupRouteDeps) {
  return credentialMode === 'generated'
    ? getProviderWalletGenerationCapability(provider, deps.venues)
    : undefined;
}

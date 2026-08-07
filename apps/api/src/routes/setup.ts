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

    const { provider, label, capability, credentialMode } = parsed.data;

    if (capability === 'trading' && !providerAllowsTradingSetup(provider)) {
      return reply.status(400).send(
        errorPayload(
          'capability.unsupported_provider',
          `Provider ${provider} is not supported for trading setup.`,
          { provider, capability },
        ),
      );
    }

    const walletCapability = credentialMode === 'generated'
      ? getProviderWalletGenerationCapability(provider, deps.venues)
      : undefined;
    if (credentialMode === 'generated') {
      if (!walletCapability) {
        return reply.status(400).send(
          errorPayload(
            'wallet_generation.unsupported_provider',
            `Provider ${provider} does not support generated wallets.`,
            { provider },
          ),
        );
      }
      if (!walletCapability.available) {
        return reply.status(400).send(
          errorPayload(
            'wallet_generation.disabled',
            `Generated wallets are not currently available for provider ${provider}.`,
            { provider },
          ),
        );
      }
    }

    const manualSecrets = credentialMode === 'manual'
      ? canonicalizeVenueSecrets(provider, parsed.data.secrets!)
      : undefined;
    if (manualSecrets) {
      const venueErrors = validateVenueSecrets(provider, manualSecrets);
      if (venueErrors.length > 0) {
        return reply.status(400).send(credentialValidationPayload(venueErrors));
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
          await tx.execute(sql`SELECT pg_advisory_xact_lock(14, hashtext(${request.userId}))`);

          const credentialCheck = await checkCredentialLimit(tx as unknown as Database, plansConfig, request.userId, request.userPlanId || 'free', request.isAdmin);
          if (!credentialCheck.ok) {
            return { kind: 'limit' as const, error: credentialCheck.error };
          }

          const connectionCheck = await checkConnectionLimit(tx as unknown as Database, plansConfig, request.userId, request.userPlanId || 'free', request.isAdmin);
          if (!connectionCheck.ok) {
            return { kind: 'limit' as const, error: connectionCheck.error };
          }

          if (capability === 'trading') {
            const venueAccountCheck = await checkVenueAccountLimit(tx as unknown as Database, plansConfig, request.userId, request.userPlanId || 'free', request.isAdmin);
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
          userId: request.userId,
          provider,
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
            userId: request.userId,
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
      request.log.error({ err, provider, credentialMode }, 'Unhandled error in provider-link transaction');
      return reply.status(500).send(
        errorPayload('setup.provider_link_failed', 'Failed to set up provider connection. Please try again.'),
      );
    }

    if (txResult.kind === 'limit') {
      return reply.status(403).send(
        errorPayload(txResult.error.code, txResult.error.message, txResult.error.params),
      );
    }
    if (txResult.kind === 'validation') {
      return reply.status(400).send(credentialValidationPayload(txResult.errors));
    }

    const response: Record<string, unknown> = {
      credential: {
        id: credentialId,
        provider,
        label,
        createdAt: now,
      },
      connection: {
        id: connectionId,
        provider,
        label,
        status: 'active',
        credentialId,
        resolvedVenueAccountId: txResult.tradingResult?.venueAccountId ?? null,
        createdAt: now,
      },
    };

    if (txResult.tradingResult) {
      response.venueAccount = {
        id: txResult.tradingResult.venueAccountId,
        venue: provider,
        label,
        createdAt: now,
      };
    }

    if (txResult.wallet && walletCapability) {
      response.wallet = {
        address: txResult.wallet.address,
        network: txResult.wallet.network,
        fundingInstructionId: walletCapability.fundingInstructionId,
        custodyMode: 'direct',
      };
    }

    return reply.status(201).send(response);
  });
}

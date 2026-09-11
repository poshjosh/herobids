import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { userCredentials, connections } from '@herobids/db';
import type { AppConfig, PlansConfig } from '@herobids/domain';
import type { TradertonClient } from '@herobids/domain/traderton';
import { generateWallet, deriveSolanaAddress } from '@herobids/venues';
import type { WalletGenerationRequest, WalletGenerationResult } from '@herobids/venues';
import { encryptCredential, getEncryptionKey } from '../crypto.js';
import { canonicalizeVenueSecrets, validateVenueSecrets } from './credentials.js';
import { checkConnectionLimit, checkCredentialLimit, checkVenueAccountLimit } from '../plan-guards.js';
import { SetupProviderLinkSchema } from '../schemas.js';
import { errorPayload, type ApiErrorDetail } from '../error-payload.js';
import { getProviderWalletGenerationCapability, providerAllowsTradingSetup } from '../providers/registry.js';
import { deleteProviderLink } from '../provider-links.js';
import { createLogger } from '../logger.js';

const logger = createLogger('setup-routes');

function credentialValidationPayload(errors: ReturnType<typeof validateVenueSecrets>) {
  const primary = errors[0]!;
  return errorPayload(primary.code, primary.message, primary.params, {
    details: errors.map<ApiErrorDetail>(({ field, code, message, params }) => ({ field, code, message, params })),
  });
}

export interface SetupRouteDeps {
  venues: AppConfig['venues'];
  generateWallet: (request: WalletGenerationRequest) => WalletGenerationResult;
  /**
   * The Traderton REST boundary client. Trading provider links provision their
   * venue account (+ credential) over this boundary — herobids never writes
   * trading credentials/venue-accounts locally. Undefined when the boundary is
   * unconfigured → trading links return a typed precondition (no local write).
   */
  tradertonClient?: TradertonClient;
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
  | { kind: 'ok'; credentialId: string | null; connectionId: string; provider: string; label: string; venueAccountId: string | null; wallet: WalletGenerationResult['wallet'] | null }
  | { kind: 'limit'; error: { code: string; message: string; params?: Record<string, unknown> } }
  | { kind: 'validation'; errors: ReturnType<typeof validateVenueSecrets> }
  | { kind: 'error'; code: string; message: string; params?: Record<string, unknown> }
  | { kind: 'fault'; code: string; message: string; params?: Record<string, unknown> };

/**
 * Shared provider-link creation logic used by both the HTTP route and the
 * Guided Setup `create_connection` chat tool.
 *
 * Two behaviours, split on capability:
 *
 * - Non-trading links stay entirely herobids-owned: a local `user_credentials`
 *   row + a `connections` row are written in one local transaction.
 *
 * - Trading links (capability = "trading") move the credential + venue account
 *   behind the Traderton boundary (L3-P1b). herobids performs NO local trading
 *   credential/venue-account write. The flow is:
 *     Phase 0 — validation, plan-limit checks, wallet generation, secret
 *               canonicalisation + validation, venueAccountRef resolution
 *               (all local, no remote work).
 *     Phase 1 — `provision_venue_account` over the boundary (create the
 *               credential + venue account; returns metadata only).
 *     Phase 2 — a local transaction inserting ONLY the `connections` row
 *               (credentialId = null; resolvedVenueAccountId = the boundary's
 *               venueAccountId), re-checking plan limits under the advisory lock.
 *     Compensation — if Phase 2 fails after a successful provision, call
 *               `deprovision_venue_account` to roll back the boundary rows.
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

  const connectionId = crypto.randomUUID();
  const now = new Date();

  // ── Phase 0 — all local, no-remote work ───────────────────────────────────
  // Generate the wallet (if requested), canonicalise + validate the secrets,
  // and resolve the venueAccountRef BEFORE any boundary call so a boundary
  // invocation only ever carries validated inputs.
  const generated = credentialMode === 'generated'
    ? deps.generateWallet({ provider, enabled: walletCapability!.available, network: walletCapability!.network })
    : undefined;
  const normalizedSecrets = generated
    ? canonicalizeVenueSecrets(provider, generated.secrets)
    : manualSecrets!;
  const venueErrors = validateVenueSecrets(provider, normalizedSecrets);
  if (venueErrors.length > 0) {
    return { kind: 'validation', errors: venueErrors };
  }

  const isTrading = capability === 'trading';

  // Resolve venueAccountRef (trading only):
  // - generated wallet → use the generated address
  // - manual Hyperliquid → walletAddress from secrets
  // - manual Jupiter → derive Solana address from private key
  // - other manual → null (venue-specific resolution downstream)
  const resolvedVenueAccountRef: string | null = isTrading
    ? (generated?.wallet.address
        ?? (provider === 'hyperliquid' ? normalizedSecrets['walletAddress'] ?? null : null)
        ?? (provider === 'jupiter' && normalizedSecrets['privateKey']
          ? deriveSolanaAddress(normalizedSecrets['privateKey'])
          : null))
    : null;

  if (isTrading) {
    return createTradingProviderLink(db, plansConfig, deps, {
      userId,
      planId,
      admin,
      provider,
      label,
      connectionId,
      normalizedSecrets,
      resolvedVenueAccountRef,
      wallet: generated?.wallet ?? null,
      now,
    });
  }

  // ── Non-trading path — entirely herobids-owned (unchanged) ─────────────────
  // A local credential + connection in one transaction. These credentials stay
  // herobids-owned (e.g. Gmail/OAuth, telegram, twitter) and never cross the
  // trading boundary.
  const encryptionKey = getEncryptionKey();
  const credentialId = crypto.randomUUID();

  let txResult: {
    kind: 'limit';
    error: { code: string; message: string; params?: Record<string, unknown> };
  } | {
    kind: 'ok';
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

      return { kind: 'ok' as const, wallet: generated?.wallet ?? null };
    });
  } catch (err) {
    logger.error({ err, provider, credentialMode, userId }, 'createProviderLink: unexpected error');
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

  return {
    kind: 'ok',
    credentialId,
    connectionId,
    provider,
    label,
    venueAccountId: null,
    wallet: txResult.wallet,
  };
}

interface CreateTradingProviderLinkInput {
  userId: string;
  planId: string;
  admin: boolean;
  provider: string;
  label: string;
  connectionId: string;
  normalizedSecrets: Record<string, string>;
  resolvedVenueAccountRef: string | null;
  wallet: WalletGenerationResult['wallet'] | null;
  now: Date;
}

/**
 * The trading half of createProviderLink (L3-P1b): provision the venue account
 * + credential over the Traderton boundary, then insert ONLY the local
 * connection. herobids performs NO local trading credential/venue-account write.
 */
async function createTradingProviderLink(
  db: Database,
  plansConfig: PlansConfig | undefined,
  deps: SetupRouteDeps,
  input: CreateTradingProviderLinkInput,
): Promise<CreateProviderLinkResult> {
  const { userId, planId, admin, provider, label, connectionId, normalizedSecrets, resolvedVenueAccountRef, wallet, now } = input;

  // ── Phase 1 — provision over the boundary ──────────────────────────────────
  // The credential + venue account are created behind the boundary; the tool
  // returns metadata only (venueAccountId — never the credentialId or secrets).
  // The idempotencyKey is the pre-minted connectionId so a transport retry
  // reuses the same provisioning request (005 §Deadlines/Retries).
  const client = deps.tradertonClient;
  const provisionResult = client
    ? await client.invoke({
        toolName: 'provision_venue_account',
        payload: {
          venue: provider,
          label,
          secrets: normalizedSecrets,
          ...(resolvedVenueAccountRef ? { venueAccountRef: resolvedVenueAccountRef } : {}),
        },
        subject: { ownerId: userId, actor: { type: 'user', id: userId } },
        deadlineMs: 30_000,
        idempotencyKey: connectionId,
      })
    // No client configured → treat as a transport error (no local write).
    : { kind: 'transport_error' as const, requestId: '', retryable: true as const, message: 'trading boundary not configured' };

  if (provisionResult.kind === 'transport_error') {
    return { kind: 'fault', code: 'precondition.not_ready', message: 'Trading service is unavailable — the connection was not created.', params: { provider } };
  }
  if (provisionResult.kind === 'in_progress') {
    return { kind: 'fault', code: 'boundary.in_progress', message: 'Venue provisioning did not complete in time. Please retry.', params: { provider } };
  }
  if (provisionResult.kind === 'failure') {
    // A limit/authz/validation failure from the boundary — nothing local written yet.
    if (provisionResult.code === 'rate_limit.exceeded') {
      return { kind: 'limit', error: { code: provisionResult.code, message: provisionResult.message, params: {} } };
    }
    return { kind: 'error', code: provisionResult.code, message: provisionResult.message, params: {} };
  }

  const provisionPayload = provisionResult.payload as { venueAccountId?: unknown } | null;
  const venueAccountId = typeof provisionPayload?.venueAccountId === 'string' ? provisionPayload.venueAccountId : null;
  if (!venueAccountId) {
    // The boundary reported success but without the expected metadata — do not
    // strand it silently; roll it back is impossible without an id, so log + fault.
    logger.error({ provider, userId, payload: provisionResult.payload }, 'provision_venue_account succeeded without a venueAccountId');
    return { kind: 'fault', code: 'setup.provider_link_failed', message: 'Failed to set up provider connection. Please try again.', params: { provider } };
  }

  // ── Phase 2 — local platform half (connection only) ────────────────────────
  // Insert ONLY the connections row: credentialId is null (the boundary owns the
  // credential), resolvedVenueAccountId is the boundary's venueAccountId. Plan
  // limits are re-checked here under the advisory lock so the over-limit
  // protection is preserved end-to-end.
  try {
    const txResult = await db.transaction(async (tx) => {
      if (plansConfig) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(14, hashtext(${userId}))`);

        const connectionCheck = await checkConnectionLimit(tx as unknown as Database, plansConfig, userId, planId, admin);
        if (!connectionCheck.ok) {
          return { kind: 'limit' as const, error: connectionCheck.error };
        }

        const venueAccountCheck = await checkVenueAccountLimit(tx as unknown as Database, plansConfig, userId, planId, admin);
        if (!venueAccountCheck.ok) {
          return { kind: 'limit' as const, error: venueAccountCheck.error };
        }
      }

      await tx.insert(connections).values({
        id: connectionId,
        userId,
        credentialId: null,
        provider,
        label,
        status: 'active',
        resolvedVenueAccountId: venueAccountId,
        meta: null,
        createdAt: now,
        updatedAt: now,
      });

      return { kind: 'ok' as const };
    });

    if (txResult.kind === 'limit') {
      // Over-limit is a caller error, not a fault: compensate the boundary rows
      // so we do not strand an orphan venue account, then return the limit.
      await compensateProvision(client, userId, venueAccountId, provider);
      return { kind: 'limit', error: txResult.error };
    }
  } catch (err) {
    // Phase 2 failed AFTER a successful provision — compensate the boundary.
    logger.error({ err, provider, userId, venueAccountId }, 'createProviderLink: local connection insert failed after provision — compensating');
    await compensateProvision(client, userId, venueAccountId, provider);
    return { kind: 'fault', code: 'setup.provider_link_failed', message: 'Failed to set up provider connection. Please try again.', params: { provider } };
  }

  return {
    kind: 'ok',
    credentialId: null,
    connectionId,
    provider,
    label,
    venueAccountId,
    wallet,
  };
}

/**
 * Roll back a successful provision when the local platform half fails. A failed
 * compensating deprovision leaves an orphan venue account behind the boundary —
 * acceptable and logged; never thrown (the caller has already decided its
 * outcome).
 */
async function compensateProvision(
  client: TradertonClient | undefined,
  userId: string,
  venueAccountId: string,
  provider: string,
): Promise<void> {
  if (!client) return;
  try {
    const result = await client.invoke({
      toolName: 'deprovision_venue_account',
      payload: { venueAccountId },
      subject: { ownerId: userId, actor: { type: 'user', id: userId } },
      deadlineMs: 30_000,
      idempotencyKey: `deprovision:${venueAccountId}`,
    });
    if (result.kind !== 'success') {
      logger.error({ provider, userId, venueAccountId, result }, 'compensating deprovision_venue_account did not succeed — orphan venue account left behind the boundary');
    }
  } catch (err) {
    logger.error({ err, provider, userId, venueAccountId }, 'compensating deprovision_venue_account threw — orphan venue account left behind the boundary');
  }
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
      // Boundary transport/in-progress preconditions surface as 503 (retryable
      // upstream), unexpected local faults as 500 — mirroring the bots.ts
      // boundary conventions.
      const status = result.code === 'precondition.not_ready' || result.code === 'boundary.in_progress' ? 503 : 500;
      return reply.status(status).send(
        errorPayload(result.code, result.message, result.params),
      );
    }
    // result.kind === 'error' — map boundary failure codes to HTTP status
    // (bots.ts create_bot conventions).
    const status = result.code === 'validation.invalid_payload' ? 400
      : result.code === 'authorization.denied' ? 403
      : result.code === 'not_found.resource' ? 404
      : result.code === 'rate_limit.exceeded' ? 429
      : result.code === 'capability.unsupported_provider'
        || result.code === 'wallet_generation.unsupported_provider'
        || result.code === 'wallet_generation.disabled' ? 400
      : 502;
    return reply.status(status).send(
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
        const result = await deleteProviderLink(db, connectionId, request.userId, deps.tradertonClient);

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
          // A boundary transport/in-progress precondition is a retryable 503;
          // other faults (e.g. a local delete race) stay 500.
          const status = result.code === 'precondition.not_ready' ? 503 : 500;
          return reply.status(status).send(
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

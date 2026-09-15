import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { platformCredentials, connections } from '@herobids/db';
import type { AppConfig, PlansConfig } from '@herobids/domain';
import type { TradertonClient } from '@herobids/domain/traderton';
import { deriveSolanaAddress } from '@herobids/venues';
import { encryptCredential, getEncryptionKey } from '../crypto.js';
import { canonicalizeVenueSecrets, validateVenueSecrets } from '../providers/venue-secrets.js';
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

/**
 * The public wallet returned by a generated trading link. The keypair is minted
 * BEHIND the Traderton boundary (`provision_venue_account` generate mode); only
 * the public address + network cross back — never the private key. Surfaced to
 * the user so they can fund the generated address.
 */
export interface ProvisionedWallet {
  address: string;
  network: string;
}

export interface SetupRouteDeps {
  venues: AppConfig['venues'];
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
  | { kind: 'ok'; credentialId: string | null; connectionId: string; provider: string; label: string; venueAccountId: string | null; wallet: ProvisionedWallet | null }
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
 *     Phase 0 — validation, plan-limit checks, and (manual mode only) secret
 *               canonicalisation + validation + venueAccountRef resolution
 *               (all local, no remote work). GENERATED wallets are NO LONGER
 *               minted locally (D1-3b): generate mode is requested over the
 *               boundary in Phase 1 and Traderton mints the keypair.
 *     Phase 1 — `provision_venue_account` over the boundary. Manual mode passes
 *               the validated secrets; generate mode passes `{ generate:{network} }`
 *               and the boundary mints the keypair + returns the public wallet
 *               address (never the private key). Returns metadata only.
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

  const isTrading = capability === 'trading';

  // ── Generated + trading path — mint BEHIND the boundary ────────────────────
  // The keypair is no longer minted in-process. Instead we thread a `generate`
  // intent through to `provision_venue_account` (generate mode), which mints the
  // keypair behind the boundary and returns the public address only. The network
  // is the wallet-capability network — the same value previously passed to the
  // local generator. (The schema enforces generated ⇒ capability = "trading",
  // and every wallet-generation provider is a trading venue, so a generated link
  // is always a trading link.)
  if (credentialMode === 'generated') {
    return createTradingProviderLink(db, plansConfig, deps, {
      userId,
      planId,
      admin,
      provider,
      label,
      connectionId,
      mode: { kind: 'generate', network: walletCapability!.network },
      now,
    });
  }

  // ── Phase 0 (manual) — all local, no-remote work ───────────────────────────
  // Canonicalise + validate the secrets and resolve the venueAccountRef BEFORE
  // any boundary call so a boundary invocation only ever carries validated
  // inputs.
  const normalizedSecrets = manualSecrets!;
  const venueErrors = validateVenueSecrets(provider, normalizedSecrets);
  if (venueErrors.length > 0) {
    return { kind: 'validation', errors: venueErrors };
  }

  // Resolve venueAccountRef (manual trading only):
  // - Hyperliquid → walletAddress from secrets
  // - Jupiter → derive Solana address from private key
  // - other → null (venue-specific resolution downstream)
  const resolvedVenueAccountRef: string | null = isTrading
    ? ((provider === 'hyperliquid' ? normalizedSecrets['walletAddress'] ?? null : null)
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
      mode: { kind: 'manual', secrets: normalizedSecrets, venueAccountRef: resolvedVenueAccountRef },
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

      await tx.insert(platformCredentials).values({
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

      return { kind: 'ok' as const };
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
    wallet: null,
  };
}

/**
 * How a trading provider link sources its credential/keypair:
 * - `manual`   → the user supplied validated secrets; herobids resolves the
 *                venueAccountRef locally (pre-boundary) and forwards both.
 * - `generate` → the keypair is minted BEHIND the boundary; herobids forwards
 *                only the network and reads the public wallet back from the
 *                provision result.
 */
type TradingProvisionMode =
  | { kind: 'manual'; secrets: Record<string, string>; venueAccountRef: string | null }
  | { kind: 'generate'; network: string };

interface CreateTradingProviderLinkInput {
  userId: string;
  planId: string;
  admin: boolean;
  provider: string;
  label: string;
  connectionId: string;
  mode: TradingProvisionMode;
  now: Date;
}

/**
 * Defensively parse the public wallet from an unknown provision-success payload.
 * Returns null unless both `address` and `network` are present as strings — the
 * private key is never part of this payload (it stays behind the boundary).
 */
function parseProvisionedWallet(value: unknown): ProvisionedWallet | null {
  if (typeof value !== 'object' || value === null) return null;
  const { address, network } = value as { address?: unknown; network?: unknown };
  if (typeof address === 'string' && typeof network === 'string') {
    return { address, network };
  }
  return null;
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
  const { userId, planId, admin, provider, label, connectionId, mode, now } = input;
  const client = deps.tradertonClient;

  // ── Phase 0 — pre-provision plan-limit check (venue accounts) ──────────────
  // The venue-account count now lives behind the boundary, so this check makes
  // a boundary HTTP call and MUST run BEFORE provisioning (never inside the
  // Phase-2 DB transaction). On a limit/precondition failure we return before
  // provisioning, so there is nothing to compensate. The connection-limit check
  // stays local and is re-checked under the advisory lock in Phase 2.
  if (plansConfig) {
    const venueAccountCheck = await checkVenueAccountLimit(client, plansConfig, userId, planId, admin);
    if (!venueAccountCheck.ok) {
      // precondition.not_ready → boundary unavailable → fault (503); any other
      // limit failure → limit (403). No provision has run yet.
      if (venueAccountCheck.error.code === 'precondition.not_ready') {
        return { kind: 'fault', code: venueAccountCheck.error.code, message: venueAccountCheck.error.message, params: venueAccountCheck.error.params };
      }
      return { kind: 'limit', error: venueAccountCheck.error };
    }
  }

  // ── Phase 1 — provision over the boundary ──────────────────────────────────
  // The credential + venue account are created behind the boundary; the tool
  // returns metadata only (venueAccountId — never the credentialId or secrets).
  // In `generate` mode the keypair is minted behind the boundary and the public
  // wallet ({ address, network }) is returned so the user can fund it; herobids
  // forwards only the network and never sees the private key. In `manual` mode
  // herobids forwards the validated secrets (+ resolved venueAccountRef). The
  // two payload shapes are mutually exclusive (generate XOR secrets).
  // The idempotencyKey is the pre-minted connectionId so a transport retry
  // reuses the same provisioning request (005 §Deadlines/Retries).
  const provisionPayload = mode.kind === 'generate'
    ? { venue: provider, label, generate: { network: mode.network } }
    : {
        venue: provider,
        label,
        secrets: mode.secrets,
        ...(mode.venueAccountRef ? { venueAccountRef: mode.venueAccountRef } : {}),
      };
  const provisionResult = client
    ? await client.invoke({
        toolName: 'provision_venue_account',
        payload: provisionPayload,
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

  const successPayload = provisionResult.payload as { venueAccountId?: unknown; wallet?: unknown } | null;
  const venueAccountId = typeof successPayload?.venueAccountId === 'string' ? successPayload.venueAccountId : null;
  // In generate mode the boundary mints the keypair and returns the public
  // wallet ({ address, network } | null). Parse it defensively from the unknown
  // payload — the private key never crosses the boundary.
  const wallet = parseProvisionedWallet(successPayload?.wallet);
  if (!venueAccountId) {
    // The boundary reported success but without the expected metadata — do not
    // strand it silently; roll it back is impossible without an id, so log + fault.
    logger.error({ provider, userId, payload: provisionResult.payload }, 'provision_venue_account succeeded without a venueAccountId');
    return { kind: 'fault', code: 'setup.provider_link_failed', message: 'Failed to set up provider connection. Please try again.', params: { provider } };
  }
  // Observability: in generate mode the boundary is contracted to return the
  // public minted wallet so the user can fund it. A generate success with no
  // wallet is a boundary-contract regression — the connection still succeeds
  // (non-fatal), but log it so the silent drop of the funding address is visible.
  if (mode.kind === 'generate' && !wallet) {
    logger.error({ provider, userId, venueAccountId }, 'provision_venue_account generate mode succeeded without a wallet — user has no funding address');
  }

  // ── Phase 2 — local platform half (connection only) ────────────────────────
  // Insert ONLY the connections row: credentialId is null (the boundary owns the
  // credential), resolvedVenueAccountId is the boundary's venueAccountId. The
  // connection limit is re-checked here under the advisory lock so the
  // over-limit protection is preserved end-to-end. The venue-account limit was
  // already checked pre-provision (Phase 0) — it sources its count from the
  // boundary and so cannot run inside this transaction.
  try {
    const txResult = await db.transaction(async (tx) => {
      if (plansConfig) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(14, hashtext(${userId}))`);

        const connectionCheck = await checkConnectionLimit(tx as unknown as Database, plansConfig, userId, planId, admin);
        if (!connectionCheck.ok) {
          return { kind: 'limit' as const, error: connectionCheck.error };
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
  deps: SetupRouteDeps = { venues: {} },
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

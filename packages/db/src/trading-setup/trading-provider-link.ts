import { sql } from 'drizzle-orm';
import type { PlansConfig } from '@herobids/domain';
import type { ExternalBackendClient } from '@herobids/domain/external-backend';
import type { Database } from '../index.js';
import { connections } from '../schema/index.js';
import { checkConnectionLimit, checkVenueAccountLimit } from '../plan-guards.js';

/**
 * The public wallet returned by a generated trading link. The keypair is minted
 * BEHIND the Traderton boundary (`provision_venue_account` generate mode); only
 * the public address + network cross back — never the private key.
 */
export interface ProvisionedWallet {
  address: string;
  network: string;
}

export interface TradingLinkLogger {
  error(context: Record<string, unknown>, message: string): void;
}

export interface TradingLinkDeps {
  client?: ExternalBackendClient;
  logger: TradingLinkLogger;
}

export type TradingProviderLinkResult =
  | { kind: 'ok'; credentialId: null; connectionId: string; provider: string; label: string; venueAccountId: string; wallet: ProvisionedWallet | null }
  | { kind: 'limit'; error: { code: string; message: string; params?: Record<string, unknown> } }
  | { kind: 'error'; code: string; message: string; params?: Record<string, unknown> }
  | { kind: 'fault'; code: string; message: string; params?: Record<string, unknown> };

/**
 * How a trading provider link sources its credential/keypair:
 * - `manual`   → the user supplied validated secrets; the venueAccountRef is
 *                resolved locally (pre-boundary) and both are forwarded.
 * - `generate` → the keypair is minted BEHIND the boundary; only the network is
 *                forwarded and the public wallet is read back.
 */
export type TradingProvisionMode =
  | { kind: 'manual'; secrets: Record<string, string>; venueAccountRef: string | null }
  | { kind: 'generate'; network: string };

export interface CreateTradingProviderLinkInput {
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
 * Returns null unless both `address` and `network` are strings.
 */
export function parseProvisionedWallet(value: unknown): ProvisionedWallet | null {
  if (typeof value !== 'object' || value === null) return null;
  const { address, network } = value as { address?: unknown; network?: unknown };
  if (typeof address === 'string' && typeof network === 'string') {
    return { address, network };
  }
  return null;
}

/**
 * The trading provider link (L3-P1b): provision the venue account + credential
 * over the Traderton boundary, then insert ONLY the local connection. The
 * platform performs NO local trading credential or venue-account write.
 */
export async function createTradingProviderLink(
  db: Database,
  plansConfig: PlansConfig | undefined,
  deps: TradingLinkDeps,
  input: CreateTradingProviderLinkInput,
): Promise<TradingProviderLinkResult> {
  const { userId, planId, admin, provider, label, connectionId, mode, now } = input;
  const client = deps.client;

  // Phase 0: the venue-account count sits behind the boundary, so this check runs
  // before provisioning and never inside the Phase-2 transaction.
  if (plansConfig) {
    const venueAccountCheck = await checkVenueAccountLimit(client, plansConfig, userId, planId, admin);
    if (!venueAccountCheck.ok) {
      // precondition.not_ready → boundary unavailable → fault; any other limit failure → limit.
      if (venueAccountCheck.error.code === 'precondition.not_ready') {
        return { kind: 'fault', code: venueAccountCheck.error.code, message: venueAccountCheck.error.message, params: venueAccountCheck.error.params };
      }
      return { kind: 'limit', error: venueAccountCheck.error };
    }
  }

  // Phase 1: provision over the boundary. The two payload shapes are mutually
  // exclusive (generate XOR secrets). The idempotencyKey is the pre-minted
  // connectionId so a transport retry reuses the same provisioning request.
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
    : { kind: 'transport_error' as const, requestId: '', retryable: true as const, message: 'trading boundary not configured' };

  if (provisionResult.kind === 'transport_error') {
    return { kind: 'fault', code: 'precondition.not_ready', message: 'Trading service is unavailable — the connection was not created.', params: { provider } };
  }
  if (provisionResult.kind === 'in_progress') {
    return { kind: 'fault', code: 'boundary.in_progress', message: 'Venue provisioning did not complete in time. Please retry.', params: { provider } };
  }
  if (provisionResult.kind === 'failure') {
    if (provisionResult.code === 'rate_limit.exceeded') {
      return { kind: 'limit', error: { code: provisionResult.code, message: provisionResult.message, params: {} } };
    }
    return { kind: 'error', code: provisionResult.code, message: provisionResult.message, params: {} };
  }

  const successPayload = provisionResult.payload as { venueAccountId?: unknown; wallet?: unknown } | null;
  const venueAccountId = typeof successPayload?.venueAccountId === 'string' ? successPayload.venueAccountId : null;
  const wallet = parseProvisionedWallet(successPayload?.wallet);
  if (!venueAccountId) {
    deps.logger.error({ provider, userId, payload: provisionResult.payload }, 'provision_venue_account succeeded without a venueAccountId');
    return { kind: 'fault', code: 'setup.provider_link_failed', message: 'Failed to set up provider connection. Please try again.', params: { provider } };
  }
  if (mode.kind === 'generate' && !wallet) {
    deps.logger.error({ provider, userId, venueAccountId }, 'provision_venue_account generate mode succeeded without a wallet — user has no funding address');
  }

  // Phase 2: insert ONLY the connections row (credentialId is null; the boundary
  // owns the credential). The connection limit is re-checked under the advisory lock.
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
      // Over-limit is a caller error: compensate so no orphan venue account is stranded.
      await compensateProvision(deps, userId, venueAccountId, provider);
      return { kind: 'limit', error: txResult.error };
    }
  } catch (err) {
    deps.logger.error({ err, provider, userId, venueAccountId }, 'trading link: local connection insert failed after provision — compensating');
    await compensateProvision(deps, userId, venueAccountId, provider);
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
 * compensating deprovision is logged, never thrown: the caller already decided its outcome.
 */
export async function compensateProvision(
  deps: TradingLinkDeps,
  userId: string,
  venueAccountId: string,
  provider: string,
): Promise<void> {
  if (!deps.client) return;
  try {
    const result = await deps.client.invoke({
      toolName: 'deprovision_venue_account',
      payload: { venueAccountId },
      subject: { ownerId: userId, actor: { type: 'user', id: userId } },
      deadlineMs: 30_000,
      idempotencyKey: `deprovision:${venueAccountId}`,
    });
    if (result.kind !== 'success') {
      deps.logger.error({ provider, userId, venueAccountId, result }, 'compensating deprovision_venue_account did not succeed — orphan venue account left behind the boundary');
    }
  } catch (err) {
    deps.logger.error({ err, provider, userId, venueAccountId }, 'compensating deprovision_venue_account threw — orphan venue account left behind the boundary');
  }
}

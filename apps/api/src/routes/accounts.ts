import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { venueAccounts, userCredentials } from '@herobids/db';
import type { AppConfig, PlansConfig } from '@herobids/domain';
import type { TradertonClient } from '@herobids/domain/traderton';
import { HyperliquidAdapter } from '@herobids/venues';
import { JupiterSwapAdapter, OneInchSwapAdapter } from '@herobids/venues';
import { CreateVenueAccountSchema } from '../schemas.js';
import { checkVenueAccountLimit } from '../plan-guards.js';
import { errorPayload } from '../error-payload.js';

/**
 * Extract a tool-level errorCode from a boundary failure. The dispatcher maps a
 * copied tool's `errorCode` (e.g. `provision.in_use`, `not_found.resource`) onto
 * the closed wire `code` and carries the original under `details.errorCode`.
 */
function toolErrorCode(details: Record<string, unknown> | undefined): string | undefined {
  const code = details?.['errorCode'];
  return typeof code === 'string' ? code : undefined;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Validate a Solana public key by base58-decoding and checking the byte length is exactly 32.
 * No dependency required — base58 decoding is a trivial big-integer conversion.
 */
function isValidSolanaAddress(address: string): boolean {
  let value = 0n;
  for (const char of address) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) return false; // character not in base58 alphabet
    value = value * 58n + BigInt(idx);
  }
  // Leading '1' characters each encode a leading zero byte
  let leadingZeros = 0;
  for (const char of address) {
    if (char !== '1') break;
    leadingZeros++;
  }
  const bytes: number[] = [];
  let v = value;
  while (v > 0n) { bytes.unshift(Number(v & 0xffn)); v >>= 8n; }
  return leadingZeros + bytes.length === 32;
}

export async function venueAccountRoutes(
  app: FastifyInstance,
  db: Database,
  plansConfig?: PlansConfig,
  venueConfigs?: AppConfig['venues'],
  tradertonClient?: TradertonClient,
): Promise<void> {
  // Create venue account
  app.post('/venue-accounts', async (request, reply) => {
    const parsed = CreateVenueAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Plan enforcement
    if (plansConfig) {
      const planCheck = await checkVenueAccountLimit(db, plansConfig, request.userId, request.userPlanId || 'free', request.isAdmin);
      if (!planCheck.ok) {
        return reply.status(403).send(errorPayload(planCheck.error.code, planCheck.error.message, planCheck.error.params));
      }
    }

    // Validate credential linkage if credentialId is provided — scope the lookup by userId so
    // that a credential owned by another user returns the same "not found" response as a
    // genuinely missing credential (prevents probing foreign credential IDs).
    if (parsed.data.credentialId) {
      const [cred] = await db
        .select({ id: userCredentials.id, provider: userCredentials.provider })
        .from(userCredentials)
        .where(and(eq(userCredentials.id, parsed.data.credentialId), eq(userCredentials.userId, request.userId)));

      if (!cred) {
        return reply.status(400).send(
          errorPayload('credential.not_found', `Credential ${parsed.data.credentialId} does not exist`, {
            credentialId: parsed.data.credentialId,
          }),
        );
      }

      if (cred.provider !== parsed.data.venue) {
        return reply.status(400).send(
          errorPayload('credential.provider_mismatch', `Credential is for provider "${cred.provider}", not "${parsed.data.venue}"`, {
            credentialProvider: cred.provider,
            venue: parsed.data.venue,
          }),
        );
      }
    }

    // Venue-specific required field enforcement
    // Normalise early so the trimmed value is used for validation, probe and persistence.
    if (parsed.data.venueAccountRef != null) {
      parsed.data.venueAccountRef = parsed.data.venueAccountRef.trim();
    }
    if (parsed.data.venue === 'jupiter') {
      const ref = parsed.data.venueAccountRef ?? '';
      if (!ref) {
        return reply.status(400).send(
          errorPayload(
            'account.validation_error.missing_venue_account_ref',
            'venueAccountRef (Solana wallet address) is required for Jupiter venue accounts',
            { field: 'venueAccountRef', venue: 'jupiter' },
          ),
        );
      }
      // Decode base58 and verify the result is exactly 32 bytes (Ed25519 public key)
      if (!isValidSolanaAddress(ref)) {
        return reply.status(400).send(
          errorPayload(
            'account.validation_error.invalid_venue_account_ref',
            'venueAccountRef must be a valid Solana wallet address (32-byte base58-encoded public key)',
            { field: 'venueAccountRef', venue: 'jupiter' },
          ),
        );
      }
    }
    if (parsed.data.venue === '1inch' && !parsed.data.credentialId) {
      return reply.status(400).send(
        errorPayload(
          'account.validation_error.missing_credential_id',
          'credentialId is required for 1inch venue accounts',
          { field: 'credentialId', venue: '1inch' },
        ),
      );
    }

    const id = crypto.randomUUID();
    const now = new Date();

    // Best-effort venue probe — determines available symbols and execution modes.
    // Runs unauthenticated (public API) since we don't decrypt credentials here.
    let venueProfile = null;
    try {
      if (parsed.data.venue === 'hyperliquid') {
        // Unauthenticated probe always targets mainnet (testnet requires explicit credentials)
        venueProfile = await HyperliquidAdapter.probe(undefined, {
          baseUrl: venueConfigs?.['hyperliquid']?.baseUrl,
        });
      } else if (parsed.data.venue === 'jupiter') {
        venueProfile = await JupiterSwapAdapter.probe(parsed.data.venueAccountRef);
      } else if (parsed.data.venue === '1inch') {
        venueProfile = OneInchSwapAdapter.probe(!!parsed.data.credentialId);
      }
    } catch {
      // Non-fatal — account is still created without a cached profile
    }

    try {
      await db.insert(venueAccounts).values({
        id,
        userId: request.userId,
        venue: parsed.data.venue,
        label: parsed.data.label,
        venueAccountRef: parsed.data.venueAccountRef ?? null,
        credentialId: parsed.data.credentialId ?? null,
        venueProfile: venueProfile ?? undefined,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err: unknown) {
      // FK violation — credential deleted between validation and insert
      const pgErr = err as { code?: string };
      if (pgErr.code === '23503') {
        return reply.status(400).send(
          errorPayload(
            'credential.not_found',
            `Credential ${parsed.data.credentialId} was removed before the account could be created`,
            { credentialId: parsed.data.credentialId },
          ),
        );
      }
      throw err;
    }

    const [account] = await db.select().from(venueAccounts).where(eq(venueAccounts.id, id));
    return reply.status(201).send(account);
  });

  // List venue accounts
  app.get('/venue-accounts', async (request, reply) => {
    const accounts = await db.select().from(venueAccounts).where(eq(venueAccounts.userId, request.userId));
    return reply.send({ venueAccounts: accounts });
  });

  // Delete venue account (L3-P1b: re-pointed to the Traderton boundary).
  //
  // venue_accounts now live behind the boundary, so herobids no longer loads
  // the account locally to 404 on absence. The boundary owns owner-scoping,
  // the any-bot in-use block, and the credential cascade; herobids injects the
  // subject (ownerId = request.userId, actor = user) and maps the result:
  //   not_found.resource → 404 (owner-scoped: unowned/absent look identical)
  //   provision.in_use   → 409 venue_account_in_use
  //   success            → { status: 'deleted', venueAccountId }
  app.delete<{ Params: { id: string } }>('/venue-accounts/:id', async (request, reply) => {
    const { id } = request.params;

    const result = tradertonClient
      ? await tradertonClient.invoke({
          toolName: 'deprovision_venue_account',
          payload: { venueAccountId: id },
          subject: { ownerId: request.userId, actor: { type: 'user', id: request.userId } },
          deadlineMs: 30_000,
          idempotencyKey: `deprovision:${id}`,
        })
      : { kind: 'transport_error' as const, requestId: '', retryable: true as const, message: 'trading boundary not configured' };

    if (result.kind === 'transport_error' || result.kind === 'in_progress') {
      return reply.status(503).send(
        errorPayload('precondition.not_ready', 'Trading service is unavailable — the venue account was not deleted.', {}),
      );
    }

    if (result.kind === 'failure') {
      const errorCode = toolErrorCode(result.details);
      if (errorCode === 'not_found.resource') {
        return reply.status(404).send({ error: 'not_found' });
      }
      if (errorCode === 'provision.in_use') {
        // Surface the same shape as before. blockingBotIds are derivable from
        // the boundary's `details.botIds` when present, else omit (the boundary
        // owns bots — herobids no longer reads them locally).
        const botIds = Array.isArray(result.details?.['botIds'])
          ? (result.details!['botIds'] as unknown[]).filter((b): b is string => typeof b === 'string')
          : undefined;
        return reply.status(409).send({
          error: 'venue_account_in_use',
          venueAccountId: id,
          ...(botIds ? { blockingBotIds: botIds } : {}),
        });
      }
      const status = result.code === 'authorization.denied' ? 403
        : result.code === 'rate_limit.exceeded' ? 429
        : result.code === 'validation.invalid_payload' ? 400
        : 502;
      return reply.status(status).send(errorPayload(result.code, result.message, {}));
    }

    return reply.send({ status: 'deleted', venueAccountId: id });
  });
}

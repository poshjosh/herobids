import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { venueAccounts, userCredentials } from '@herobids/db';
import type { AppConfig, PlansConfig } from '@herobids/domain';
import { HyperliquidAdapter } from '@herobids/venues';
import { JupiterSwapAdapter, OneInchSwapAdapter } from '@herobids/venues';
import { CreateVenueAccountSchema } from '../schemas.js';
import { checkVenueAccountLimit } from '../plan-guards.js';
import { errorPayload } from '../error-payload.js';

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
        .select({ id: userCredentials.id, venue: userCredentials.venue })
        .from(userCredentials)
        .where(and(eq(userCredentials.id, parsed.data.credentialId), eq(userCredentials.userId, request.userId)));

      if (!cred) {
        return reply.status(400).send(
          errorPayload('credential.not_found', `Credential ${parsed.data.credentialId} does not exist`, {
            credentialId: parsed.data.credentialId,
          }),
        );
      }

      if (cred.venue !== parsed.data.venue) {
        return reply.status(400).send(
          errorPayload('credential.venue_mismatch', `Credential is for venue "${cred.venue}", not "${parsed.data.venue}"`, {
            credentialVenue: cred.venue,
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
}

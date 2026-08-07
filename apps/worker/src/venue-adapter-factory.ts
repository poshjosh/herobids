import { eq } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { venueAccounts, userCredentials } from '@herobids/db';
import type { OrderbookVenuePort, SwapVenuePort } from '@herobids/domain';
import { HyperliquidAdapter, BybitAdapter, JupiterSwapAdapter, OneInchSwapAdapter, SolanaSigner, JupiterConfirmationPoller, EvmConfirmationPoller, deriveSolanaAddress } from '@herobids/venues';
import type { SwapConfirmationPoller } from '@herobids/venues';
import { credentialDecryptedEvent } from '@herobids/engine';
import type { Journal } from '@herobids/engine';
import { decryptCredential } from './crypto.js';
import type { StreamConfig } from './trading-actor.js';
import { createLogger } from './logger.js';

const logger = createLogger('venue-adapter-factory');

export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialResolutionError';
  }
}

export interface VenueConfig {
  baseUrl?: string;
  wsUrl?: string;
  wsPublicUrl?: string;
  wsPrivateUrl?: string;
  wsTestnetPrivateUrl?: string;
  testnetBaseUrl?: string;
  testnetWsUrl?: string;
  rpcUrl?: string;
  chainId?: number;
  tokenSafetyNetwork?: string;
  rateLimitPerSec?: number;
  timeoutMs?: number;
  confirmationTimeoutMs?: number;
  routerAddress?: string;
  apiKey?: string;
}

export interface OrderbookAdapterResult {
  venuePort: OrderbookVenuePort;
  credentials: { apiKey: string; secret: string; walletAddress: string; testnet: boolean };
  credentialId: string | undefined;
}

export interface SwapAdapterResult {
  swapVenue: SwapVenuePort;
  walletAddress: string;
  /** Credential ID used for signing (if resolved from DB). Undefined for paper/shadow without signing. */
  credentialId?: string;
  /** Whether a transaction signer is configured (required for live execution) */
  signerPresent: boolean;
  /** Venue-specific confirmation poller for authoritative on-chain tx status checks */
  confirmationPoller?: SwapConfirmationPoller;
}

export interface VenueAdapterFactoryDeps {
  db: Database;
  journal: Journal;
  venues: Record<string, VenueConfig | undefined>;
  streamConfig: StreamConfig;
}

/**
 * VenueAdapterFactory — shared factory for constructing venue adapters.
 *
 * Encapsulates credential resolution (DB lookup + decrypt) and adapter construction
 * for both orderbook (Hyperliquid, Bybit) and swap (Jupiter, 1inch) venues.
 * Used by both bot startup (TradingActor) and agent startup (AgentTradingActor).
 */
export class VenueAdapterFactory {
  constructor(private readonly deps: VenueAdapterFactoryDeps) {}

  async buildOrderbookAdapter(opts: {
    venueAccountId: string;
    venue: string;
    actorType: string;
    actorId: string;
    executionMode: 'paper' | 'shadow' | 'live';
  }): Promise<OrderbookAdapterResult> {
    const { venueAccountId, venue, actorType, actorId, executionMode } = opts;
    const { db, journal, venues, streamConfig } = this.deps;

    let apiKey = '';
    let secret = '';
    let walletAddress = '';
    let testnet = false;
    let resolvedCredentialId: string | undefined;
    let pendingCredentialId: string | undefined;

    try {
      const [account] = await db.select().from(venueAccounts).where(eq(venueAccounts.id, venueAccountId)).limit(1);
      if (account?.credentialId) {
        pendingCredentialId = account.credentialId;
        const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.id, account.credentialId)).limit(1);
        if (cred) {
          const encryptionKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];
          if (encryptionKey) {
            const decrypted = JSON.parse(decryptCredential(cred.encryptedData, encryptionKey)) as { apiKey: string; secret: string; walletAddress?: string; testnet?: boolean };
            apiKey = decrypted.apiKey;
            secret = decrypted.secret;
            walletAddress = decrypted.walletAddress || walletAddress;
            testnet = decrypted.testnet ?? false;
            resolvedCredentialId = account.credentialId;
            journal.append(credentialDecryptedEvent({
              credentialId: account.credentialId,
              venue,
              venueAccountId,
              botId: actorId,
              outcome: 'success',
            })).catch((err) => { logger.error({ err, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
          } else {
            journal.append(credentialDecryptedEvent({
              credentialId: account.credentialId,
              venue,
              venueAccountId,
              botId: actorId,
              outcome: 'failure',
              error: 'CREDENTIAL_ENCRYPTION_KEY not set',
            })).catch((err) => { logger.error({ err, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
            throw new CredentialResolutionError(`CREDENTIAL_ENCRYPTION_KEY not set — cannot decrypt credentials for venueAccount ${venueAccountId}`);
          }
        } else {
          journal.append(credentialDecryptedEvent({
            credentialId: account.credentialId,
            venue,
            venueAccountId,
            botId: actorId,
            outcome: 'failure',
            error: 'Credential record not found (dangling reference)',
          })).catch((err) => { logger.error({ err, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
          throw new CredentialResolutionError(`Credential record not found for venueAccount ${venueAccountId}`);
        }
      } else if (executionMode !== 'paper') {
        throw new CredentialResolutionError(`Venue account ${venueAccountId} has no linked credential`);
      } else {
        logger.warn({ venueAccountId, actorId, actorType }, 'Paper mode: venue account has no linked credential — proceeding without credentials');
      }
    } catch (err) {
      if (err instanceof CredentialResolutionError) throw err;
      if (pendingCredentialId) {
        journal.append(credentialDecryptedEvent({
          credentialId: pendingCredentialId,
          venue,
          venueAccountId,
          botId: actorId,
          outcome: 'failure',
          error: err instanceof Error ? err.message : String(err),
        })).catch((auditErr) => { logger.error({ err: auditErr, credentialId: pendingCredentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
      }
      throw new CredentialResolutionError(`Failed to load credentials for venueAccount ${venueAccountId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const venueConfig = venues[venue];
    let venuePort: OrderbookVenuePort;
    if (venue === 'bybit') {
      venuePort = new BybitAdapter({
        credentials: { apiKey, secret, testnet },
        wsUrl: venueConfig?.wsUrl,
        wsPrivateUrl: venueConfig?.wsPrivateUrl,
        wsTestnetPrivateUrl: venueConfig?.wsTestnetPrivateUrl,
        streamConfig,
      });
    } else if (venue === 'hyperliquid') {
      venuePort = new HyperliquidAdapter({
        credentials: { apiKey, secret, walletAddress, testnet },
        wsUrl: venues['hyperliquid']?.wsUrl,
        testnetBaseUrl: venues['hyperliquid']?.testnetBaseUrl,
        testnetWsUrl: venues['hyperliquid']?.testnetWsUrl,
        streamConfig,
      });
    } else {
      throw new CredentialResolutionError(`Unsupported orderbook venue ${venue}`);
    }

    return {
      venuePort,
      credentials: { apiKey, secret, walletAddress, testnet },
      credentialId: resolvedCredentialId,
    };
  }

  async buildSwapAdapter(opts: {
    venueAccountId: string;
    venue: string;
    swapAssets?: { baseAsset: string; quoteAsset: string; baseDecimals: number; quoteDecimals: number };
    actorType: string;
    actorId: string;
  }): Promise<SwapAdapterResult> {
    const { venueAccountId, venue, swapAssets, actorType, actorId } = opts;
    const { db, journal, venues } = this.deps;

    const tokenDecimals: Record<string, number> = {};
    if (swapAssets) {
      tokenDecimals[swapAssets.baseAsset] = swapAssets.baseDecimals;
      tokenDecimals[swapAssets.quoteAsset] = swapAssets.quoteDecimals;
    }

    if (venue === '1inch') {
      let privateKey: string | undefined;
      const oneInchConfig = venues['1inch'];
      const oneInchApiKey = oneInchConfig?.apiKey;
      const [account] = await db.select().from(venueAccounts).where(eq(venueAccounts.id, venueAccountId)).limit(1);
      if (account?.credentialId) {
        const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.id, account.credentialId)).limit(1);
        const encryptionKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];
        if (cred && encryptionKey) {
          try {
            const decrypted = JSON.parse(decryptCredential(cred.encryptedData, encryptionKey)) as { privateKey: string };
            privateKey = decrypted.privateKey;
            journal.append(credentialDecryptedEvent({
              credentialId: account.credentialId,
              venue,
              venueAccountId,
              botId: actorId,
              outcome: 'success',
            })).catch((auditErr) => { logger.error({ err: auditErr, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
          } catch (decryptErr) {
            journal.append(credentialDecryptedEvent({
              credentialId: account.credentialId,
              venue,
              venueAccountId,
              botId: actorId,
              outcome: 'failure',
              error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
            })).catch((auditErr) => { logger.error({ err: auditErr, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
            throw new CredentialResolutionError(`Failed to decrypt 1inch credentials for venueAccount ${venueAccountId}: ${decryptErr instanceof Error ? decryptErr.message : String(decryptErr)}`);
          }
        } else if (!encryptionKey && cred) {
          journal.append(credentialDecryptedEvent({
            credentialId: account.credentialId,
            venue,
            venueAccountId,
            botId: actorId,
            outcome: 'failure',
            error: 'CREDENTIAL_ENCRYPTION_KEY not set',
          })).catch((auditErr) => { logger.error({ err: auditErr, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
          throw new CredentialResolutionError(`CREDENTIAL_ENCRYPTION_KEY not set — cannot decrypt 1inch credentials for venueAccount ${venueAccountId}`);
        } else {
          throw new CredentialResolutionError(`Credential record not found for venueAccount ${venueAccountId}`);
        }
      } else {
        throw new CredentialResolutionError(`Venue account ${venueAccountId} has no linked credential — cannot resolve 1inch secrets`);
      }
      if (!privateKey) {
        throw new CredentialResolutionError(`privateKey required for 1inch venue ${actorType} ${actorId}. Store in DB credential.`);
      }
      if (!oneInchApiKey) {
        throw new CredentialResolutionError(`Operator apiKey required for 1inch venue ${actorType} ${actorId}. Configure venues.1inch.apiKey.`);
      }
      const swapVenue = new OneInchSwapAdapter({
        apiUrl: oneInchConfig?.baseUrl ?? 'https://api.1inch.dev/swap/v6.0/8453',
        apiKey: oneInchApiKey,
        signer: {
          privateKey,
          rpcUrl: oneInchConfig?.rpcUrl ?? 'https://mainnet.base.org',
          chainId: oneInchConfig?.chainId ?? 8453,
          confirmationTimeoutMs: oneInchConfig?.confirmationTimeoutMs,
        },
        rateLimitPerSec: oneInchConfig?.rateLimitPerSec,
        tokenDecimals,
        timeoutMs: oneInchConfig?.timeoutMs,
        routerAddress: oneInchConfig?.routerAddress,
      });

      const oneInchRpcUrl = oneInchConfig?.rpcUrl ?? 'https://mainnet.base.org';
      const confirmationPoller = new EvmConfirmationPoller({ rpcUrl: oneInchRpcUrl });
      return { swapVenue, walletAddress: swapVenue.walletAddress, credentialId: account?.credentialId ?? undefined, signerPresent: true, confirmationPoller };
    }

    if (venue !== 'jupiter') {
      throw new CredentialResolutionError(`Unsupported swap venue ${venue}`);
    }

    // Jupiter requires a wallet address. Resolve from venueAccountRef first,
    // then fall back to deriving from the linked credential's private key.
    const [swapAccount] = await db.select().from(venueAccounts).where(eq(venueAccounts.id, venueAccountId)).limit(1);
    let walletAddress: string | null = swapAccount?.venueAccountRef ?? null;
    let derivedFromCredential = false;

    // Resolve Solana signer for live execution (optional — shadow/paper don't need it)
    let signer: InstanceType<typeof SolanaSigner> | undefined;
    let resolvedCredentialId: string | undefined;
    if (swapAccount?.credentialId) {
      const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.id, swapAccount.credentialId)).limit(1);
      const encryptionKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];
      if (cred && encryptionKey) {
        try {
          const decrypted = JSON.parse(decryptCredential(cred.encryptedData, encryptionKey)) as { privateKey: string };
          if (decrypted.privateKey) {
            // Derive wallet address from the private key if venueAccountRef is missing
            if (!walletAddress) {
              walletAddress = deriveSolanaAddress(decrypted.privateKey);
              if (walletAddress) {
                derivedFromCredential = true;
                logger.info({ venueAccountId, venue, actorType, actorId },
                  'Derived Jupiter wallet address from credential — venueAccountRef was missing');
              }
            }

            const jupiterRpcUrl = venues['jupiter']?.rpcUrl ?? 'https://api.mainnet-beta.solana.com';
            signer = new SolanaSigner({
              privateKey: decrypted.privateKey,
              rpcUrl: jupiterRpcUrl,
            });
            resolvedCredentialId = swapAccount.credentialId;
            journal.append(credentialDecryptedEvent({
              credentialId: swapAccount.credentialId,
              venue,
              venueAccountId,
              botId: actorId,
              outcome: 'success',
            })).catch((auditErr) => { logger.error({ err: auditErr, credentialId: swapAccount.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
          }
        } catch (decryptErr) {
          journal.append(credentialDecryptedEvent({
            credentialId: swapAccount.credentialId,
            venue,
            venueAccountId,
            botId: actorId,
            outcome: 'failure',
            error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
          })).catch((auditErr) => { logger.error({ err: auditErr, credentialId: swapAccount.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
          // Don't throw — signer is optional. Paper/shadow mode can proceed without it.
          logger.warn({ venueAccountId, venue, err: decryptErr }, 'Failed to decrypt Jupiter credentials — signing unavailable');
        }
      }
    }

    if (!walletAddress) {
      throw new CredentialResolutionError(
        `Venue account ${venueAccountId} has no venueAccountRef and no derivable wallet address — cannot resolve wallet address for swap venue ${actorType} ${actorId}`,
      );
    }

    const jupiterConfig = venues['jupiter'];
    const jupiterRpcUrl = jupiterConfig?.rpcUrl ?? 'https://api.mainnet-beta.solana.com';
    const swapVenue = new JupiterSwapAdapter({
      walletAddress,
      apiUrl: jupiterConfig?.baseUrl,
      rpcUrl: jupiterRpcUrl,
      tokenDecimals,
      timeoutMs: jupiterConfig?.timeoutMs,
      signer,
      apiKey: jupiterConfig?.apiKey,
    });

    const confirmationPoller = new JupiterConfirmationPoller({ rpcUrl: jupiterRpcUrl }, signer);
    return { swapVenue, walletAddress, credentialId: resolvedCredentialId, signerPresent: !!signer, confirmationPoller };
  }
}

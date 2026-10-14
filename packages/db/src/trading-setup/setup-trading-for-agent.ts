import crypto from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { walletNetworkForProvider, type PlansConfig, type RiskPosture } from '@herobids/domain';
import type { Database } from '../index.js';
import { connections } from '../schema/index.js';
import { grantConnectionToRunningAgent } from '../agents/agent-config-service.js';
import type { TradingProfileReconciliationSaga } from '../trading-profiles/trading-profile-reconciliation-saga.js';
import { createTradingProviderLink, type ProvisionedWallet, type TradingLinkDeps } from './trading-provider-link.js';

export interface TradingTestDefaults {
  defaultTestCapital: string;
  defaultTestProvider: string;
  generatedWalletTestSetupAllowed: boolean;
}

export interface SetupTradingDeps extends TradingLinkDeps {
  db: Database;
  plansConfig?: PlansConfig;
  saga: TradingProfileReconciliationSaga;
  defaults: TradingTestDefaults;
}

export interface SetupTradingInput {
  userId: string;
  agentId: string;
  userPlanId?: string;
  isAdmin?: boolean;
  capital?: string;
  riskPosture?: RiskPosture;
}

export type SetupTradingFailure = {
  code: string;
  message: string;
  params?: Record<string, unknown>;
};

export type SetupTradingResult =
  | {
      kind: 'ok';
      connectionId: string;
      provider: string;
      network: string;
      venueAccountId: string | null;
      wallet: ProvisionedWallet | null;
      reused: boolean;
      capital: string;
      mode: 'paper';
    }
  | ({ kind: 'error' } & SetupTradingFailure)
  | { kind: 'limit'; error: SetupTradingFailure }
  | ({ kind: 'fault' } & SetupTradingFailure);

/**
 * Provision a paper trading setup for an agent: reuse an active connection on the
 * default test provider, or create a generated test wallet, then grant it to the
 * agent with paper mode and the requested capital. Live mode is never set here.
 */
export async function setupTradingForAgent(deps: SetupTradingDeps, input: SetupTradingInput): Promise<SetupTradingResult> {
  const { defaults } = deps;
  if (!defaults.generatedWalletTestSetupAllowed) {
    return { kind: 'error', code: 'wallet_generation.disabled', message: 'Test wallets are not available right now.' };
  }

  const provider = defaults.defaultTestProvider;
  const network = walletNetworkForProvider(provider);
  if (!network) {
    return { kind: 'error', code: 'wallet_generation.unsupported_provider', message: `Provider ${provider} cannot create test wallets.`, params: { provider } };
  }

  const [existing] = await deps.db
    .select({ id: connections.id, venueAccountId: connections.resolvedVenueAccountId })
    .from(connections)
    .where(and(
      eq(connections.userId, input.userId),
      eq(connections.provider, provider),
      eq(connections.status, 'active'),
      isNotNull(connections.resolvedVenueAccountId),
    ))
    .limit(1);

  let connectionId: string;
  let venueAccountId: string | null;
  let wallet: ProvisionedWallet | null = null;
  let reused: boolean;
  if (existing) {
    connectionId = existing.id;
    venueAccountId = existing.venueAccountId;
    reused = true;
  } else {
    const link = await createTradingProviderLink(deps.db, deps.plansConfig, deps, {
      userId: input.userId,
      planId: input.userPlanId || 'free',
      admin: input.isAdmin ?? false,
      provider,
      label: `${provider} test wallet`,
      connectionId: crypto.randomUUID(),
      mode: { kind: 'generate', network },
      now: new Date(),
    });
    if (link.kind !== 'ok') return link;
    connectionId = link.connectionId;
    venueAccountId = link.venueAccountId;
    wallet = link.wallet;
    reused = false;
  }

  const capital = input.capital ?? defaults.defaultTestCapital;
  const changes = {
    capital,
    executionDefaults: { mode: 'paper' as const },
    ...(input.riskPosture ? { riskPosture: input.riskPosture } : {}),
  };
  const granted = await grantConnectionToRunningAgent(deps.db, input.agentId, connectionId, input.userId, deps.saga, { changes });
  if (!granted.ok) {
    const failure = { code: granted.error.code, message: granted.error.message };
    if (granted.error.code === 'config.internal_error') return { kind: 'fault', ...failure };
    return { kind: 'error', ...failure };
  }

  // Report the capital the platform stored, not the request: a mismatch is a failure.
  const storedCapital = venueAccountId
    ? await readStoredCapital(deps, input.userId, input.agentId, connectionId, venueAccountId)
    : null;
  if (storedCapital !== capital) {
    return {
      kind: 'fault',
      code: 'trading.capital_not_applied',
      message: `Capital ${capital} was not applied (stored ${storedCapital ?? 'nothing'}). Try again.`,
    };
  }

  return {
    kind: 'ok',
    connectionId,
    provider,
    network,
    venueAccountId,
    wallet,
    reused,
    capital: storedCapital,
    mode: 'paper',
  };
}

async function readStoredCapital(
  deps: SetupTradingDeps,
  userId: string,
  agentId: string,
  connectionId: string,
  venueAccountId: string,
): Promise<string | null> {
  const profiles = await deps.saga.readCurrentProfiles(userId, agentId, [
    { connectionId, venueAccountId, active: true, ready: true, isDefault: true },
  ]);
  return profiles.get(venueAccountId)?.capital ?? null;
}

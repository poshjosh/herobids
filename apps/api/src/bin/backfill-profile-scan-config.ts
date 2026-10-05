/**
 * Backfill the 004 scan config ({ scanMode, creatorStrategy }) onto every
 * agent's traderton trading profile (E1-H / D9).
 *
 * herobids began sending scan config with every profile write in Part A, but
 * agents whose profiles were written BEFORE that change still have a NULL
 * scan_mode in traderton (so their scan loop never starts). This one-off CLI
 * re-runs the reconciliation saga for each agent with an active trading
 * connection, which re-sends the derived scan config. It reuses the API's saga
 * construction so the write path is identical to a normal profile mutation.
 *
 * Dry-run by default: prints the planned upserts/clears per agent. Pass --apply
 * to actually send. Exits non-zero if any agent failed; a failure does not stop
 * the remaining agents.
 */

import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { createDatabase, agents, type Database } from '@herobids/db';
import type { UnifiedAgentConfig } from '@herobids/domain';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createTradingProfileSaga, type TradingProfileSagaBundle } from '../agents/create-trading-profile-saga.js';
import { loadActiveTradingProfileConnections } from '../agents/trading-profile-reconciliation-adapter.js';
import { proposeTradingProfiles, planTradingProfileReconciliation } from '../agents/trading-profile-reconciliation.js';
import { deriveProfileScanConfig } from '../agents/profile-scan-config.js';

export interface BackfillAgentRow {
  id: string;
  userId: string;
  unifiedConfig: unknown;
  style: string | null;
}

export type BackfillOutcome =
  | { agentId: string; result: 'sent' }
  | { agentId: string; result: 'unchanged' }
  | { agentId: string; result: 'failed'; errorCode: string };

/**
 * Core backfill, isolated from process/env so it is unit-testable. Processes
 * every agent that has at least one active trading-profile connection.
 */
export async function backfillProfileScanConfig(deps: {
  db: Database;
  saga: TradingProfileSagaBundle['saga'];
  agentsList: BackfillAgentRow[];
  apply: boolean;
  logger: Logger;
}): Promise<BackfillOutcome[]> {
  const { db, saga, agentsList, apply, logger } = deps;
  const outcomes: BackfillOutcome[] = [];

  for (const agent of agentsList) {
    const connections = await loadActiveTradingProfileConnections(db, agent.id);
    if (connections.length === 0) continue; // no active trading connection → nothing to backfill

    const scanConfig = deriveProfileScanConfig({
      unifiedConfig: (agent.unifiedConfig as UnifiedAgentConfig | null) ?? null,
      style: agent.style,
    });

    try {
      const priorProfiles = await saga.readCurrentProfiles(agent.userId, agent.id, connections);
      const proposedProfiles = proposeTradingProfiles({
        actorId: agent.id,
        priorProfiles,
        priorConnections: connections,
        proposedConnections: connections,
        changes: {},
        scanConfig,
      });
      const plannerInput = {
        prior: { profiles: priorProfiles, connections },
        proposed: { profiles: proposedProfiles, connections },
      };

      if (!apply) {
        const plan = planTradingProfileReconciliation(plannerInput);
        logger.info({ agentId: agent.id, upserts: plan.upserts.length, clears: plan.clears.length }, 'dry-run plan');
        outcomes.push(plan.upserts.length === 0 && plan.clears.length === 0
          ? { agentId: agent.id, result: 'unchanged' }
          : { agentId: agent.id, result: 'sent' });
        continue;
      }

      let changed = false;
      await saga.executeStaged({
        ownerId: agent.userId,
        actorId: agent.id,
        localMutationId: `backfill-scan-config:${agent.id}:${crypto.randomUUID()}`,
        preparePlannerInput: () => {
          const plan = planTradingProfileReconciliation(plannerInput);
          changed = plan.upserts.length > 0 || plan.clears.length > 0;
          return plannerInput;
        },
        commitLocal: (_tx, mark) => mark(),
      });
      outcomes.push({ agentId: agent.id, result: changed ? 'sent' : 'unchanged' });
    } catch (err) {
      const errorCode = extractErrorCode(err);
      logger.warn({ agentId: agent.id, err }, 'backfill failed for agent');
      outcomes.push({ agentId: agent.id, result: 'failed', errorCode });
    }
  }

  return outcomes;
}

function extractErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return err instanceof Error ? err.message : 'unknown';
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const logger = createLogger('backfill-profile-scan-config');
  const appConfig = loadConfig();
  const db = createDatabase(appConfig.database.url);
  // The full saga (incl. the L1 agent-actor lifecycle hook) — so a backfill that
  // changes a live agent's profile also (re)starts its traderton actor, exactly
  // like a normal profile write. Intended: this is how a backfilled scanner_gated
  // agent gets its scan loop running.
  const { saga } = createTradingProfileSaga({ appConfig, db, logger });

  const agentsList = await db.select({
    id: agents.id,
    userId: agents.userId,
    unifiedConfig: agents.unifiedConfig,
    style: agents.style,
  }).from(agents);

  const outcomes = await backfillProfileScanConfig({ db, saga, agentsList, apply, logger });

  let failed = 0;
  for (const o of outcomes) {
    if (o.result === 'failed') {
      failed += 1;
      process.stdout.write(`${o.agentId} | failed ${o.errorCode}\n`);
    } else {
      process.stdout.write(`${o.agentId} | ${o.result}\n`);
    }
  }
  process.stdout.write(`${apply ? 'applied' : 'dry-run'}: ${outcomes.length} agents, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

// Only run main when executed directly (not when imported by the test).
if (process.argv[1] && process.argv[1].endsWith('backfill-profile-scan-config.js')) {
  void main().catch((err: unknown) => {
    process.stderr.write(`backfill fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

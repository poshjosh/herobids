import type { Diff } from '@herobids/engine';
import type { PositionRepository } from '@herobids/db';

// ---------------------------------------------------------------------------
// Shared reconciliation helper for shadow/paper mode orphaned position cleanup.
//
// When an agent or bot runs in shadow/paper mode, its local positions are
// simulated and never reflected on the real venue. On startup, reconciliation
// detects "local has position, venue has no position" as drift. This helper
// auto-closes those orphaned positions so the actor can start cleanly.
//
// Non-orphaned diffs (balance mismatches, venue-only positions, unknown fills,
// orphaned orders) are returned to the caller — they remain actionable and
// should still block trading in live mode.
// ---------------------------------------------------------------------------

/** Logger subset needed by the cleanup helper — compatible with pino. */
export interface CleanupLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

/** Dependencies needed to close orphaned positions. */
export interface OrphanedPositionCleanupDeps {
  positionRepo: PositionRepository;
  venueAccountId: string;
  actorType: string;
  actorId: string;
  venue: string;
  logger: CleanupLogger;
}

/**
 * Returns true when a diff represents a local position that has no venue
 * counterpart — the defining shape of an orphaned shadow/paper position.
 */
export function isOrphanedPosition(diff: Diff): boolean {
  return diff.type === 'position_mismatch' && diff.venue === null && diff.local !== null;
}

/**
 * Auto-close orphaned local positions that have no venue counterpart.
 *
 * Idempotent: skips positions already marked flat (safe for repeated
 * reconciliation passes on reconnects).
 *
 * @returns the remaining diffs that are NOT orphaned positions — these are
 *          still actionable and should be handled by the caller (e.g. block
 *          trading in live mode).
 */
export async function cleanupOrphanedPositions(
  diffs: Diff[],
  deps: OrphanedPositionCleanupDeps,
): Promise<Diff[]> {
  const orphanedPositions = diffs.filter(isOrphanedPosition);
  const otherDiffs = diffs.filter((d) => !isOrphanedPosition(d));

  if (orphanedPositions.length === 0) {
    return otherDiffs;
  }

  deps.logger.warn(
    { orphanedCount: orphanedPositions.length, symbols: orphanedPositions.map((d) => d.symbol) },
    'Auto-closing orphaned shadow/paper positions with no venue counterpart',
  );

  for (const diff of orphanedPositions) {
    const localPos = diff.local as { side?: string; size?: string } | null;
    // Idempotency guard: skip positions already flat (e.g. from a previous
    // reconciliation pass on reconnect).
    if (!diff.symbol || !localPos?.size || localPos.side === 'flat') {
      continue;
    }
    try {
      await deps.positionRepo.upsert({
        venueAccountId: deps.venueAccountId,
        actorType: deps.actorType,
        actorId: deps.actorId,
        venue: deps.venue,
        symbol: diff.symbol,
        side: 'flat',
        size: '0',
        entryPrice: '0',
        realizedPnl: '0',
        markSource: 'reconciliation_orphaned',
      });
    } catch (closeErr) {
      deps.logger.error({ err: closeErr, symbol: diff.symbol }, 'Failed to auto-close orphaned position');
    }
  }

  if (otherDiffs.length === 0) {
    deps.logger.info(
      { orphanedCount: orphanedPositions.length },
      'All reconciliation diffs were orphaned shadow/paper positions — proceeding after auto-close',
    );
  }

  return otherDiffs;
}

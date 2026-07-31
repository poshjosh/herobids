import type { DecisionIntent } from '@herobids/domain';
import type { LevelValidationError } from '@herobids/engine';

/** Intents that grow (or initiate) a position — used for level validation and stop-loss/take-profit reminders. */
export const POSITION_GROWING_INTENTS = new Set<DecisionIntent>(['go_long', 'go_short', 'increase']);

/** Map a level validation error to a human-readable message. */
export function formatLevelValidationMessage(error: LevelValidationError): string {
  const { reason, markPrice, level } = error;
  switch (reason) {
    case 'above_mark_for_long':
      return `Rejected: stopLoss (${level}) must be below current price (${markPrice}) for a long position.`;
    case 'below_mark_for_short':
      return `Rejected: stopLoss (${level}) must be above current price (${markPrice}) for a short position.`;
    case 'below_mark_for_long':
      return `Rejected: takeProfit (${level}) must be above current price (${markPrice}) for a long position.`;
    case 'above_mark_for_short':
      return `Rejected: takeProfit (${level}) must be below current price (${markPrice}) for a short position.`;
    default: {
      const _exhaustive: never = reason;
      throw new Error(`Unhandled level validation reason: ${String(_exhaustive)}`);
    }
  }
}

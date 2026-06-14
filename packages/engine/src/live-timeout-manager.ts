import type { LiveSubmissionState } from './order-state.js';

export interface LiveTimeoutPolicy {
  limitOrderTimeoutMs: number;
  marketOrderTimeoutMs: number;
}

export interface LiveTimeoutOrder {
  id: string;
  symbol: string;
  type: string;
  status: string;
  venueRefId?: string | null;
  submissionState?: LiveSubmissionState | string | null;
  submitAttemptedAt?: string | Date | null;
  acknowledgedAt?: string | Date | null;
  createdAt?: string | Date | null;
}

export interface LiveTimeoutCancelLimitAction {
  kind: 'cancel_limit';
  orderId: string;
  venueRefId: string;
  symbol: string;
  ageMs: number;
  reason: 'limit_order_timeout';
}

export interface LiveTimeoutRecoveryAction {
  kind: 'mark_recovery_required';
  orderId: string;
  venueRefId?: string;
  symbol: string;
  ageMs: number;
  reason: 'market_order_timeout' | 'limit_order_timeout_no_venue_ref';
}

export type LiveTimeoutAction = LiveTimeoutCancelLimitAction | LiveTimeoutRecoveryAction;

const ACTIVE_STATUSES = new Set(['pending', 'open', 'partial']);

function parseTimestampMs(value: string | Date | null | undefined): number | undefined {
  if (!value) return undefined;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveAnchorMs(order: LiveTimeoutOrder): number | undefined {
  return (
    parseTimestampMs(order.acknowledgedAt)
    ?? parseTimestampMs(order.submitAttemptedAt)
    ?? parseTimestampMs(order.createdAt)
  );
}

export function computeLiveTimeoutActions(
  orders: LiveTimeoutOrder[],
  policy: LiveTimeoutPolicy,
  nowMs: number = Date.now(),
): LiveTimeoutAction[] {
  const actions: LiveTimeoutAction[] = [];

  for (const order of orders) {
    if (!ACTIVE_STATUSES.has(order.status)) {
      continue;
    }

    const anchorMs = resolveAnchorMs(order);
    if (anchorMs == null) {
      continue;
    }

    const ageMs = Math.max(0, nowMs - anchorMs);

    if (order.type === 'limit' && ageMs >= policy.limitOrderTimeoutMs) {
      if (order.venueRefId) {
        actions.push({
          kind: 'cancel_limit',
          orderId: order.id,
          venueRefId: order.venueRefId,
          symbol: order.symbol,
          ageMs,
          reason: 'limit_order_timeout',
        });
      } else {
        actions.push({
          kind: 'mark_recovery_required',
          orderId: order.id,
          symbol: order.symbol,
          ageMs,
          reason: 'limit_order_timeout_no_venue_ref',
        });
      }
      continue;
    }

    if (order.type === 'market' && ageMs >= policy.marketOrderTimeoutMs) {
      actions.push({
        kind: 'mark_recovery_required',
        orderId: order.id,
        venueRefId: order.venueRefId ?? undefined,
        symbol: order.symbol,
        ageMs,
        reason: 'market_order_timeout',
      });
    }
  }

  return actions;
}

import type { Decision } from '@herobids/domain';
import { Decimal } from '@herobids/domain';
import type { ExecutionPlan } from './planner.js';
import type { ManagedOrder, FillEvent } from './order-state.js';
import type { RiskError } from './risk-gate.js';

/**
 * Journal event types — every significant system event.
 */
export type JournalEventType =
  | 'decision.created'
  | 'plan.created'
  | 'plan.completed'
  | 'plan.failed'
  | 'order.submitted'
  | 'order.filled'
  | 'order.partial'
  | 'order.cancelled'
  | 'order.expired'
  | 'order.replaced'
  | 'order.rejected'
  | 'fill.recorded'
  | 'fill.private_stream'
  | 'order.private_stream'
  | 'risk.rejected'
  | 'instance.started'
  | 'instance.stopped'
  | 'instance.crashed'
  | 'instance.tick_error'
  | 'instance.live_blocked'
  | 'instance.live_armed'
  | 'execution.failure'
  | 'stream.disconnect'
  | 'order.submitted_to_venue'
  | 'order.acknowledged'
  | 'order.fill_confirmed_from_stream'
  | 'order.completion_recovered'
  | 'order.recovery_evaluated'
  | 'live.slippage_alert'
  | 'reconciliation.match'
  | 'reconciliation.observed_variance'
  | 'reconciliation.drift_detected'
  | 'reconciliation.drift_within_threshold'
  | 'reconciliation.correction'
  | 'credential.created'
  | 'credential.rotated'
  | 'credential.deleted'
  | 'credential.decrypted'
  | 'credential.used'
  | 'strategy.error'
  | 'guardrail.rejected';

export interface JournalEntry {
  id: string;
  botId?: string;
  actorType?: string;
  actorId?: string;
  type: JournalEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * Journal port — append-only event sink.
 * Implementations can write to DB, stdout, or both.
 */
export interface Journal {
  append(entry: Omit<JournalEntry, 'id' | 'createdAt'>): Promise<void>;
  appendBatch(entries: Omit<JournalEntry, 'id' | 'createdAt'>[]): Promise<void>;
}

/** Helper: create a journal entry for a decision */
export function decisionEvent(decision: Decision): Omit<JournalEntry, 'id' | 'createdAt'> {
  return {
    actorType: decision.actorType,
    actorId: decision.actorId,
    type: 'decision.created',
    payload: {
      decisionId: decision.id,
      instrumentId: decision.instrumentId,
      intent: decision.intent,
      targetSize: decision.targetSize.toString(),
      limitPrice: decision.limitPrice?.toString(),
      contextHash: decision.contextHash,
    },
  };
}

/** Helper: create a journal entry for a plan */
export function planEvent(plan: ExecutionPlan, type: 'plan.created' | 'plan.completed' | 'plan.failed'): Omit<JournalEntry, 'id' | 'createdAt'> {
  return {
    actorType: plan.actorType,
    actorId: plan.actorId,
    type,
    payload: {
      planId: plan.id,
      decisionId: plan.decisionId,
      action: plan.action,
      orderCount: plan.orders.length,
      venue: plan.venue,
      symbol: plan.symbol,
    },
  };
}

/** Helper: create a journal entry for an order status change */
export function orderEvent(order: ManagedOrder): Omit<JournalEntry, 'id' | 'createdAt'> {
  const typeMap: Record<string, JournalEventType> = {
    filled: 'order.filled',
    partial: 'order.partial',
    cancelled: 'order.cancelled',
    expired: 'order.expired',
    replaced: 'order.replaced',
    rejected: 'order.rejected',
  };
  return {
    actorType: order.actorType,
    actorId: order.actorId,
    type: typeMap[order.status] ?? 'order.submitted',
    payload: {
      orderId: order.id,
      venueRefId: order.venueRefId,
      side: order.side,
      type: order.type,
      quantity: order.quantity.toString(),
      price: order.price?.toString(),
      status: order.status,
      filledQuantity: order.filledQuantity.toString(),
    },
  };
}

/** Helper: create a journal entry for a fill */
export function fillEvent(fill: FillEvent): Omit<JournalEntry, 'id' | 'createdAt'> {
  return {
    actorType: fill.actorType,
    actorId: fill.actorId,
    type: 'fill.recorded',
    payload: {
      fillId: fill.id,
      orderId: fill.orderId,
      side: fill.side,
      quantity: fill.quantity.toString(),
      price: fill.price.toString(),
      fee: fill.fee?.toString(),
      feeCurrency: fill.feeCurrency,
      filledAt: fill.filledAt,
    },
  };
}

/** Helper: create a journal entry for a risk rejection */
export function riskEvent(actorType: string, actorId: string, error: RiskError): Omit<JournalEntry, 'id' | 'createdAt'> {
  return {
    actorType,
    actorId,
    type: 'risk.rejected',
    payload: {
      code: error.code,
      message: error.message,
      context: error.context,
    },
  };
}

// --- Live observability event helpers ---

export interface LiveBlockedPayload {
  reason: string;
  code: string;
  venue?: string;
  venueAccountId?: string;
}

export function liveBlockedEvent(botId: string, payload: LiveBlockedPayload): Omit<JournalEntry, 'id' | 'createdAt'> {
  return { botId, type: 'instance.live_blocked', payload: payload as unknown as Record<string, unknown> };
}

export interface LiveArmedPayload {
  venue: string;
  venueAccountId: string;
  effectiveMaxOrderNotional?: string;
}

export function liveArmedEvent(botId: string, payload: LiveArmedPayload): Omit<JournalEntry, 'id' | 'createdAt'> {
  return { botId, type: 'instance.live_armed', payload: payload as unknown as Record<string, unknown> };
}

export interface OrderSubmittedToVenuePayload {
  orderId: string;
  clientOrderId: string;
  venue: string;
  symbol: string;
  side: string;
  type: string;
  quantity: string;
  referencePrice?: string;
}

export function orderSubmittedToVenueEvent(botId: string, payload: OrderSubmittedToVenuePayload): Omit<JournalEntry, 'id' | 'createdAt'> {
  return { botId, type: 'order.submitted_to_venue', payload: payload as unknown as Record<string, unknown> };
}

export interface OrderAcknowledgedPayload {
  orderId: string;
  clientOrderId: string;
  venueRefId: string;
  venue: string;
  symbol: string;
  status: string;
}

export function orderAcknowledgedEvent(botId: string, payload: OrderAcknowledgedPayload): Omit<JournalEntry, 'id' | 'createdAt'> {
  return { botId, type: 'order.acknowledged', payload: payload as unknown as Record<string, unknown> };
}

export interface FillConfirmedFromStreamPayload {
  orderId: string;
  venueRefId: string;
  fillVenueRefId: string;
  symbol: string;
  side: string;
  quantity: string;
  price: string;
  fee?: string;
}

export function fillConfirmedFromStreamEvent(botId: string, payload: FillConfirmedFromStreamPayload): Omit<JournalEntry, 'id' | 'createdAt'> {
  return { botId, type: 'order.fill_confirmed_from_stream', payload: payload as unknown as Record<string, unknown> };
}

export interface CompletionRecoveredPayload {
  planId: string;
  orderId: string;
  venueRefId?: string;
  recoverySource: 'reconciliation' | 'private_stream' | 'startup_recovery';
}

export function completionRecoveredEvent(botId: string, payload: CompletionRecoveredPayload): Omit<JournalEntry, 'id' | 'createdAt'> {
  return { botId, type: 'order.completion_recovered', payload: payload as unknown as Record<string, unknown> };
}

export interface SlippageAlertPayload {
  orderId: string;
  venue: string;
  symbol: string;
  side: string;
  referencePrice: string;
  avgFillPrice: string;
  slippageBps: number;
  thresholdBps: number;
}

export function slippageAlertEvent(botId: string, payload: SlippageAlertPayload): Omit<JournalEntry, 'id' | 'createdAt'> {
  return { botId, type: 'live.slippage_alert', payload: payload as unknown as Record<string, unknown> };
}

/**
 * Compute slippage in basis points between reference price and actual fill price.
 * Returns positive when fill is worse than reference (buy higher, sell lower).
 * Uses Decimal arithmetic to avoid IEEE-754 precision loss on price strings.
 */
export function computeSlippageBps(referencePrice: string, avgFillPrice: string, side: 'buy' | 'sell'): number {
  const ref = new Decimal(referencePrice);
  const fill = new Decimal(avgFillPrice);
  if (ref.isZero()) return 0;
  // For buys, slippage = (fill - ref) / ref * 10000
  // For sells, slippage = (ref - fill) / ref * 10000
  const raw = side === 'buy'
    ? fill.minus(ref).div(ref).mul(10_000)
    : ref.minus(fill).div(ref).mul(10_000);
  return raw.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

// --- Credential audit event helpers ---

export interface CredentialCreatedPayload {
  credentialId: string;
  venue: string;
  userId: string;
  label: string;
}

export function credentialCreatedEvent(payload: CredentialCreatedPayload): Omit<JournalEntry, 'id' | 'createdAt'> {
  return { type: 'credential.created', payload: payload as unknown as Record<string, unknown> };
}

export interface CredentialRotatedPayload {
  credentialId: string;
  venue: string;
  userId?: string;
}

export function credentialRotatedEvent(payload: CredentialRotatedPayload): Omit<JournalEntry, 'id' | 'createdAt'> {
  return { type: 'credential.rotated', payload: payload as unknown as Record<string, unknown> };
}

export interface CredentialDeletedPayload {
  credentialId: string;
  venue: string;
  userId?: string;
}

export function credentialDeletedEvent(payload: CredentialDeletedPayload): Omit<JournalEntry, 'id' | 'createdAt'> {
  return { type: 'credential.deleted', payload: payload as unknown as Record<string, unknown> };
}

export interface CredentialDecryptedPayload {
  credentialId: string;
  venue: string;
  venueAccountId: string;
  botId?: string;
  outcome: 'success' | 'failure';
  error?: string;
}

export function credentialDecryptedEvent(payload: CredentialDecryptedPayload): Omit<JournalEntry, 'id' | 'createdAt'> {
  return { botId: payload.botId, type: 'credential.decrypted', payload: payload as unknown as Record<string, unknown> };
}

export interface CredentialUsedPayload {
  credentialId: string;
  venue: string;
  venueAccountId: string;
  action: string;
  ordersSubmitted: number;
}

export function credentialUsedEvent(botId: string, payload: CredentialUsedPayload): Omit<JournalEntry, 'id' | 'createdAt'> {
  return { botId, type: 'credential.used', payload: payload as unknown as Record<string, unknown> };
}

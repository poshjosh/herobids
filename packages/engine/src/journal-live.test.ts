import { describe, it, expect } from 'vitest';
import {
  liveBlockedEvent,
  liveArmedEvent,
  orderSubmittedToVenueEvent,
  orderAcknowledgedEvent,
  fillConfirmedFromStreamEvent,
  completionRecoveredEvent,
  slippageAlertEvent,
  computeSlippageBps,
  credentialCreatedEvent,
  credentialRotatedEvent,
  credentialDeletedEvent,
  credentialDecryptedEvent,
  credentialUsedEvent,
} from './journal.js';
import type { JournalEventType } from './journal.js';

describe('live journal event helpers', () => {
  it('liveBlockedEvent produces correct shape', () => {
    const entry = liveBlockedEvent('inst-1', {
      reason: 'Live mode disabled',
      code: 'live_rollout.disabled',
      venue: 'hyperliquid',
      venueAccountId: 'va-1',
    });
    expect(entry.type).toBe('instance.live_blocked' satisfies JournalEventType);
    expect(entry.botId).toBe('inst-1');
    expect(entry.payload).toMatchObject({ reason: 'Live mode disabled', code: 'live_rollout.disabled' });
  });

  it('liveArmedEvent produces correct shape', () => {
    const entry = liveArmedEvent('inst-2', {
      venue: 'hyperliquid',
      venueAccountId: 'va-2',
      effectiveMaxOrderNotional: '50',
    });
    expect(entry.type).toBe('instance.live_armed' satisfies JournalEventType);
    expect(entry.payload).toMatchObject({ venue: 'hyperliquid', effectiveMaxOrderNotional: '50' });
  });

  it('orderSubmittedToVenueEvent produces correct shape', () => {
    const entry = orderSubmittedToVenueEvent('inst-1', {
      orderId: 'o-1',
      clientOrderId: 'inst-1:plan-1:0',
      venue: 'hyperliquid',
      symbol: 'ETH/USD:USD',
      side: 'buy',
      type: 'market',
      quantity: '0.5',
      referencePrice: '3000.5',
    });
    expect(entry.type).toBe('order.submitted_to_venue' satisfies JournalEventType);
    expect(entry.payload).toMatchObject({ orderId: 'o-1', referencePrice: '3000.5' });
  });

  it('orderAcknowledgedEvent produces correct shape', () => {
    const entry = orderAcknowledgedEvent('inst-1', {
      orderId: 'o-1',
      clientOrderId: 'inst-1:plan-1:0',
      venueRefId: 'venue-123',
      venue: 'hyperliquid',
      symbol: 'ETH/USD:USD',
      status: 'open',
    });
    expect(entry.type).toBe('order.acknowledged' satisfies JournalEventType);
    expect(entry.payload).toMatchObject({ venueRefId: 'venue-123' });
  });

  it('fillConfirmedFromStreamEvent produces correct shape', () => {
    const entry = fillConfirmedFromStreamEvent('inst-1', {
      orderId: 'o-1',
      venueRefId: 'venue-123',
      fillVenueRefId: 'fill-456',
      symbol: 'ETH/USD:USD',
      side: 'buy',
      quantity: '0.5',
      price: '3001.2',
      fee: '0.75',
    });
    expect(entry.type).toBe('order.fill_confirmed_from_stream' satisfies JournalEventType);
    expect(entry.payload).toMatchObject({ fillVenueRefId: 'fill-456', price: '3001.2' });
  });

  it('completionRecoveredEvent produces correct shape', () => {
    const entry = completionRecoveredEvent('inst-1', {
      planId: 'plan-1',
      orderId: 'o-1',
      venueRefId: 'venue-123',
      recoverySource: 'reconciliation',
    });
    expect(entry.type).toBe('order.completion_recovered' satisfies JournalEventType);
    expect(entry.payload).toMatchObject({ recoverySource: 'reconciliation' });
  });

  it('slippageAlertEvent produces correct shape', () => {
    const entry = slippageAlertEvent('inst-1', {
      orderId: 'o-1',
      venue: 'hyperliquid',
      symbol: 'ETH/USD:USD',
      side: 'buy',
      referencePrice: '3000',
      avgFillPrice: '3015',
      slippageBps: 50,
      thresholdBps: 50,
    });
    expect(entry.type).toBe('live.slippage_alert' satisfies JournalEventType);
    expect(entry.payload).toMatchObject({ slippageBps: 50, thresholdBps: 50 });
  });
});

describe('computeSlippageBps', () => {
  it('returns positive for buy slippage (filled higher)', () => {
    const bps = computeSlippageBps('3000', '3015', 'buy');
    expect(bps).toBe(50); // (15/3000) * 10000 = 50
  });

  it('returns positive for sell slippage (filled lower)', () => {
    const bps = computeSlippageBps('3000', '2985', 'sell');
    expect(bps).toBe(50); // (15/3000) * 10000 = 50
  });

  it('returns negative when fill is better than reference (buy lower)', () => {
    const bps = computeSlippageBps('3000', '2985', 'buy');
    expect(bps).toBe(-50);
  });

  it('returns 0 when reference price is 0', () => {
    const bps = computeSlippageBps('0', '100', 'buy');
    expect(bps).toBe(0);
  });

  it('returns 0 when prices match exactly', () => {
    const bps = computeSlippageBps('3000', '3000', 'buy');
    expect(bps).toBe(0);
  });

  it('handles fractional bps correctly', () => {
    // 1 bps = 0.01% = 0.0001 relative
    const bps = computeSlippageBps('10000', '10001', 'buy');
    expect(bps).toBe(1); // (1/10000) * 10000 = 1
  });
});

describe('credential audit event helpers', () => {
  it('credentialCreatedEvent produces correct shape without secrets', () => {
    const entry = credentialCreatedEvent({
      credentialId: 'cred-1',
      venue: 'hyperliquid',
      userId: 'user-1',
      label: 'prod-key',
    });
    expect(entry.type).toBe('credential.created');
    expect(entry.botId).toBeUndefined();
    expect(entry.payload).toMatchObject({
      credentialId: 'cred-1',
      venue: 'hyperliquid',
      userId: 'user-1',
      label: 'prod-key',
    });
  });

  it('credentialRotatedEvent produces correct shape', () => {
    const entry = credentialRotatedEvent({
      credentialId: 'cred-2',
      venue: 'hyperliquid',
      userId: 'user-1',
    });
    expect(entry.type).toBe('credential.rotated');
    expect(entry.payload.credentialId).toBe('cred-2');
  });

  it('credentialDeletedEvent produces correct shape', () => {
    const entry = credentialDeletedEvent({
      credentialId: 'cred-3',
      venue: 'hyperliquid',
      userId: 'user-2',
    });
    expect(entry.type).toBe('credential.deleted');
    expect(entry.payload.credentialId).toBe('cred-3');
  });

  it('credentialDecryptedEvent includes botId and outcome', () => {
    const entry = credentialDecryptedEvent({
      credentialId: 'cred-4',
      venue: 'hyperliquid',
      venueAccountId: 'va-1',
      botId: 'inst-1',
      outcome: 'success',
    });
    expect(entry.type).toBe('credential.decrypted');
    expect(entry.botId).toBe('inst-1');
    expect(entry.payload.outcome).toBe('success');
    expect(entry.payload.error).toBeUndefined();
  });

  it('credentialDecryptedEvent includes error on failure', () => {
    const entry = credentialDecryptedEvent({
      credentialId: 'cred-5',
      venue: 'hyperliquid',
      venueAccountId: 'va-2',
      botId: 'inst-2',
      outcome: 'failure',
      error: 'Key not set',
    });
    expect(entry.type).toBe('credential.decrypted');
    expect(entry.payload.outcome).toBe('failure');
    expect(entry.payload.error).toBe('Key not set');
  });

  it('credentialUsedEvent includes ordersSubmitted count', () => {
    const entry = credentialUsedEvent('inst-3', {
      credentialId: 'cred-6',
      venue: 'hyperliquid',
      venueAccountId: 'va-3',
      action: 'live_order_submit',
      ordersSubmitted: 2,
    });
    expect(entry.type).toBe('credential.used');
    expect(entry.botId).toBe('inst-3');
    expect(entry.payload.ordersSubmitted).toBe(2);
    expect(entry.payload.action).toBe('live_order_submit');
  });
});

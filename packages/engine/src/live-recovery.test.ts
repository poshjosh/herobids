import { describe, expect, it } from 'vitest';
import { evaluateOrderbookRecovery } from './live-recovery.js';

describe('evaluateOrderbookRecovery', () => {
  it('keeps executing when open orders are present', () => {
    const result = evaluateOrderbookRecovery({
      orders: [{ id: 'o1', status: 'open', submissionState: 'venue_acknowledged', venueRefId: 'v1' }],
      hasOpenOrders: true,
      matchedFillCount: 0,
      matchedOrdersFromLookup: [],
      lookupAmbiguous: false,
    });

    expect(result).toEqual({ kind: 'keep_executing', reason: 'open_orders_present' });
  });

  it('marks completed when fill evidence exists', () => {
    const result = evaluateOrderbookRecovery({
      orders: [{ id: 'o1', status: 'pending', submissionState: 'submit_attempting', clientOrderId: 'c1' }],
      hasOpenOrders: false,
      matchedFillCount: 1,
      matchedOrdersFromLookup: [],
      lookupAmbiguous: false,
    });

    expect(result).toEqual({ kind: 'mark_completed', reason: 'fills_confirmed' });
  });

  it('halts as ambiguous when venue lookup is ambiguous', () => {
    const result = evaluateOrderbookRecovery({
      orders: [{ id: 'o1', status: 'pending', submissionState: 'submit_attempting', clientOrderId: 'c1' }],
      hasOpenOrders: false,
      matchedFillCount: 0,
      matchedOrdersFromLookup: [],
      lookupAmbiguous: true,
    });

    expect(result).toEqual({ kind: 'halt_ambiguous', reason: 'venue_lookup_ambiguous' });
  });

  it('marks failed when order was prepared but not submitted', () => {
    const result = evaluateOrderbookRecovery({
      orders: [{ id: 'o1', status: 'pending', submissionState: 'prepared', clientOrderId: 'c1' }],
      hasOpenOrders: false,
      matchedFillCount: 0,
      matchedOrdersFromLookup: [],
      lookupAmbiguous: false,
    });

    expect(result).toEqual({ kind: 'mark_failed', reason: 'prepared_not_submitted' });
  });

  it('halts as ambiguous for submit-attempting without evidence', () => {
    const result = evaluateOrderbookRecovery({
      orders: [{ id: 'o1', status: 'pending', submissionState: 'submit_attempting', clientOrderId: 'c1' }],
      hasOpenOrders: false,
      matchedFillCount: 0,
      matchedOrdersFromLookup: [],
      lookupAmbiguous: false,
    });

    expect(result).toEqual({ kind: 'halt_ambiguous', reason: 'submit_attempting_without_proof_of_absence' });
  });
});

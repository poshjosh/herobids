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
      noOrdersPlanned: false,
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
      noOrdersPlanned: false,
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
      noOrdersPlanned: false,
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
      noOrdersPlanned: false,
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
      noOrdersPlanned: false,
    });

    expect(result).toEqual({ kind: 'halt_ambiguous', reason: 'submit_attempting_without_proof_of_absence' });
  });

  it('marks failed when all orders are expired or replaced (terminal non-filled)', () => {
    const result = evaluateOrderbookRecovery({
      orders: [
        { id: 'o1', status: 'expired', submissionState: 'terminal' },
        { id: 'o2', status: 'replaced', submissionState: 'terminal' },
      ],
      hasOpenOrders: false,
      matchedFillCount: 0,
      matchedOrdersFromLookup: [],
      lookupAmbiguous: false,
      noOrdersPlanned: false,
    });

    expect(result).toEqual({ kind: 'mark_failed', reason: 'all_orders_terminal_non_filled', terminalStatuses: [{ status: 'expired', count: 1 }, { status: 'replaced', count: 1 }] });
  });

  it('returns fillEvidence when keep_executing and fills are also present', () => {
    const result = evaluateOrderbookRecovery({
      orders: [
        { id: 'o1', status: 'open', submissionState: 'venue_acknowledged', venueRefId: 'v1' },
        { id: 'o2', status: 'filled', submissionState: 'terminal', venueRefId: 'v2' },
      ],
      hasOpenOrders: true,
      matchedFillCount: 1,
      matchedOrdersFromLookup: [],
      lookupAmbiguous: false,
      noOrdersPlanned: false,
    });
    expect(result.reason).toBe('open_orders_present');
    expect(result.fillEvidence).toBeDefined();
    expect(result.fillEvidence!.hasFills).toBe(true);
    expect(result.fillEvidence!.hasLocalFilledOrders).toBe(true);
  });

  it('distinguishes noOrdersPlanned from no_orders_submitted', () => {
    const planned = evaluateOrderbookRecovery({
      orders: [],
      hasOpenOrders: false,
      matchedFillCount: 0,
      matchedOrdersFromLookup: [],
      lookupAmbiguous: false,
      noOrdersPlanned: true,
    });

    expect(planned).toEqual({ kind: 'mark_failed', reason: 'no_orders_planned' });

    const notSubmitted = evaluateOrderbookRecovery({
      orders: [],
      hasOpenOrders: false,
      matchedFillCount: 0,
      matchedOrdersFromLookup: [],
      lookupAmbiguous: false,
      noOrdersPlanned: false,
    });

    expect(notSubmitted).toEqual({ kind: 'mark_failed', reason: 'no_orders_submitted' });
  });
});

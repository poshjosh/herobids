import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TradertonReadResult } from '@herobids/domain';
import {
  loadOperatorRiskDefaults,
  clearOperatorRiskDefaultsCache,
} from './traderton-operator-defaults.js';
import type { TradertonReadBoundary } from './routes/exports-traderton.js';

/** Build a stubbable boundary whose `invoke` result is driven by a mock fn. */
function makeStubBoundary(
  invoke: (input: { toolName: string; payload: unknown }) => Promise<TradertonReadResult>,
): TradertonReadBoundary {
  return { invoke };
}

const sampleDefaults = {
  maxOpenPositions: 3,
  maxPositionSize: 250_000,
  maxPositionSizePct: 50,
  dailyMaxLossPct: 12,
};

beforeEach(() => {
  clearOperatorRiskDefaultsCache();
});

describe('loadOperatorRiskDefaults', () => {
  it('returns typed data on boundary success and round-trips a field', async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: 'success',
      data: sampleDefaults,
    } satisfies TradertonReadResult);
    const boundary = makeStubBoundary(invoke);

    const result = await loadOperatorRiskDefaults(boundary);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.maxOpenPositions).toBe(3);
      expect(result.data.maxPositionSize).toBe(250_000);
      expect(result.data.maxPositionSizePct).toBe(50);
    }
    expect(invoke).toHaveBeenCalledWith({ toolName: 'get_operator_defaults', payload: {} });
  });

  it('maps a boundary failure to a 502 ReadBoundaryError', async () => {
    const boundary = makeStubBoundary(
      vi.fn().mockResolvedValue({
        kind: 'failure',
        code: 'validation.invalid_payload',
        message: 'x',
        retryable: false,
      } satisfies TradertonReadResult),
    );

    const result = await loadOperatorRiskDefaults(boundary);

    expect(result).toEqual({
      ok: false,
      error: {
        status: 502,
        code: 'validation.invalid_payload',
        message: 'x',
      },
    });
  });

  it('maps a transport_error to a 503 precondition.not_ready', async () => {
    const boundary = makeStubBoundary(
      vi.fn().mockResolvedValue({
        kind: 'transport_error',
        message: 'down',
        retryable: true,
      } satisfies TradertonReadResult),
    );

    const result = await loadOperatorRiskDefaults(boundary);

    expect(result).toEqual({
      ok: false,
      error: {
        status: 503,
        code: 'precondition.not_ready',
        message: 'Trading service is unavailable — the export could not be produced.',
      },
    });
  });

  it('serves the second call from cache (boundary invoked once)', async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: 'success',
      data: sampleDefaults,
    } satisfies TradertonReadResult);
    const boundary = makeStubBoundary(invoke);

    const first = await loadOperatorRiskDefaults(boundary);
    const second = await loadOperatorRiskDefaults(boundary);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.maxOpenPositions).toBe(3);
    }
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures and re-invokes on the next call', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'failure',
        code: 'validation.invalid_payload',
        message: 'x',
        retryable: false,
      } satisfies TradertonReadResult)
      .mockResolvedValueOnce({
        kind: 'success',
        data: sampleDefaults,
      } satisfies TradertonReadResult);
    const boundary = makeStubBoundary(invoke);

    const failed = await loadOperatorRiskDefaults(boundary);
    const succeeded = await loadOperatorRiskDefaults(boundary);

    expect(failed.ok).toBe(false);
    expect(succeeded.ok).toBe(true);
    if (succeeded.ok) {
      expect(succeeded.data.maxOpenPositions).toBe(3);
    }
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
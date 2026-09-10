import { describe, it, expect, vi } from 'vitest';
import { mapClientResultToReadResult, createTradertonReadBoundary } from './read-adapter.js';
import type { TradertonClient, TradertonClientResult } from './client.js';
import type { TradertonSubject } from './contract.js';

describe('mapClientResultToReadResult', () => {
  it('maps success — payload becomes data', () => {
    const client: TradertonClientResult = {
      kind: 'success',
      requestId: 'req-1',
      correlationId: 'corr-1',
      payload: { ok: true, value: 42 },
    };
    expect(mapClientResultToReadResult(client)).toEqual({ kind: 'success', data: { ok: true, value: 42 } });
  });

  it('maps failure — preserves code/message/retryable verbatim', () => {
    const client: TradertonClientResult = {
      kind: 'failure',
      requestId: 'req-1',
      correlationId: 'corr-1',
      code: 'not_found.resource',
      message: 'bot not found',
      retryable: false,
    };
    expect(mapClientResultToReadResult(client)).toEqual({
      kind: 'failure',
      code: 'not_found.resource',
      message: 'bot not found',
      retryable: false,
    });
  });

  it('maps a retryable failure preserving retryable:true', () => {
    const client: TradertonClientResult = {
      kind: 'failure',
      requestId: 'req-1',
      correlationId: 'corr-1',
      code: 'upstream.transient',
      message: 'try again',
      retryable: true,
    };
    expect(mapClientResultToReadResult(client)).toMatchObject({ kind: 'failure', retryable: true });
  });

  it('maps in_progress', () => {
    const client: TradertonClientResult = { kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' };
    expect(mapClientResultToReadResult(client)).toEqual({ kind: 'in_progress' });
  });

  it('maps transport_error — retryable true, carries message', () => {
    const client: TradertonClientResult = {
      kind: 'transport_error',
      requestId: 'req-1',
      retryable: true,
      message: 'boundary unreachable',
    };
    expect(mapClientResultToReadResult(client)).toEqual({
      kind: 'transport_error',
      message: 'boundary unreachable',
      retryable: true,
    });
  });
});

describe('createTradertonReadBoundary', () => {
  const subject: TradertonSubject = { ownerId: 'owner-1', actor: { type: 'agent', id: 'agent-1' } };

  it('binds subject + deadline and forwards toolName/payload to the client', async () => {
    const invoke = vi.fn(
      async (): Promise<TradertonClientResult> => ({
        kind: 'success',
        requestId: 'req-1',
        correlationId: 'corr-1',
        payload: { ok: true },
      }),
    );
    const client = { invoke } as unknown as TradertonClient;

    const boundary = createTradertonReadBoundary(client, subject, 10_000);
    const result = await boundary.invoke({ toolName: 'get_analytics', payload: { days: 7 } });

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'get_analytics',
      payload: { days: 7 },
      subject,
      deadlineMs: 10_000,
    });
    expect(result).toEqual({ kind: 'success', data: { ok: true } });
  });

  it('maps a client transport_error through to the domain result', async () => {
    const invoke = vi.fn(
      async (): Promise<TradertonClientResult> => ({
        kind: 'transport_error',
        requestId: 'req-1',
        retryable: true,
        message: 'fetch failed',
      }),
    );
    const client = { invoke } as unknown as TradertonClient;

    const boundary = createTradertonReadBoundary(client, subject, 5_000);
    const result = await boundary.invoke({ toolName: 'list_positions', payload: {} });

    expect(result).toEqual({ kind: 'transport_error', message: 'fetch failed', retryable: true });
  });
});

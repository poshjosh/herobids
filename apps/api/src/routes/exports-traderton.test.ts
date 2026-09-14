import { describe, it, expect, vi } from 'vitest';
import {
  createTradertonReadBoundary,
  loadBoundaryObject,
  loadAgentEvidence,
  toFillRow,
  type TradertonReadBoundary,
} from './exports-traderton.js';
import type {
  TradertonClient,
  TradertonClientResult,
  TradertonSubject,
} from '@herobids/domain/traderton';

const SUBJECT: TradertonSubject = {
  ownerId: 'owner-1',
  actor: { type: 'user', id: 'owner-1' },
};

/**
 * Build a read boundary over a stub client whose `invoke` always resolves to the
 * given scripted client result. Returns the boundary plus the underlying spy so
 * callers can assert what was dispatched onto the client (tool/payload/subject).
 */
function boundaryOver(result: TradertonClientResult): {
  boundary: TradertonReadBoundary;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn().mockResolvedValue(result);
  const client = { invoke } as unknown as TradertonClient;
  return { boundary: createTradertonReadBoundary(client, SUBJECT, 10_000), invoke };
}

const successResult = (payload: unknown): TradertonClientResult => ({
  kind: 'success',
  requestId: 'r',
  correlationId: 'c',
  payload,
});

// ─── loadBoundaryObject ───────────────────────────────────────────────────────

describe('loadBoundaryObject', () => {
  it('returns the whole object payload on success', async () => {
    const { boundary, invoke } = boundaryOver(
      successResult({ ok: true, config: { strategy: 'momentum' }, extra: 1 }),
    );

    const loaded = await loadBoundaryObject(boundary, 'get_owner_bot_status', { botId: 'bot-1' });

    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data).toEqual({ ok: true, config: { strategy: 'momentum' }, extra: 1 });
    }

    // The tool name + payload + bound subject + deadline are dispatched onto the client.
    const arg = invoke.mock.calls[0]![0] as {
      toolName: string;
      payload: Record<string, unknown>;
      subject: TradertonSubject;
      deadlineMs: number;
    };
    expect(arg.toolName).toBe('get_owner_bot_status');
    expect(arg.payload).toEqual({ botId: 'bot-1' });
    expect(arg.subject).toEqual(SUBJECT);
    expect(arg.deadlineMs).toBe(10_000);
  });

  it('surfaces not_found.resource as the failure code (details.errorCode unwrap)', async () => {
    // The REAL boundary maps a tool fault onto the closed wire code
    // validation.invalid_payload and carries the original under details.errorCode.
    const { boundary } = boundaryOver({
      kind: 'failure',
      requestId: 'r',
      correlationId: 'c',
      code: 'validation.invalid_payload',
      message: 'Bot not found',
      retryable: false,
      details: { errorCode: 'not_found.resource' },
    });

    const loaded = await loadBoundaryObject(boundary, 'get_owner_bot_status', { botId: 'nope' });

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('not_found.resource');
      expect(loaded.error.status).toBe(502);
    }
  });

  it('maps a transport_error to a 503 precondition.not_ready', async () => {
    const { boundary } = boundaryOver({
      kind: 'transport_error',
      requestId: 'r',
      retryable: true,
      message: 'boundary down',
    });

    const loaded = await loadBoundaryObject(boundary, 'get_owner_bot_status', { botId: 'bot-1' });

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.status).toBe(503);
      expect(loaded.error.code).toBe('precondition.not_ready');
    }
  });

  it('maps an in_progress outcome to a 503 boundary.in_progress', async () => {
    const { boundary } = boundaryOver({
      kind: 'in_progress',
      requestId: 'r',
      correlationId: 'c',
    });

    const loaded = await loadBoundaryObject(boundary, 'get_owner_bot_status', { botId: 'bot-1' });

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.status).toBe(503);
      expect(loaded.error.code).toBe('boundary.in_progress');
    }
  });

  it('throws when the success payload is not an object', async () => {
    const { boundary } = boundaryOver(successResult('not-an-object'));

    await expect(
      loadBoundaryObject(boundary, 'get_owner_bot_status', { botId: 'bot-1' }),
    ).rejects.toThrow(/non-object payload/);
  });
});

// ─── mapClientResultToReadResult (details.errorCode unwrap) ───────────────────
//
// The unwrap logic is exercised through the exported boundary + loaders (the
// mapping function itself is module-private). loadAgentEvidence surfaces the
// failure code the same way loadBoundaryObject does.

describe('boundary failure-code unwrapping', () => {
  it('unwraps details.errorCode when the wire code is validation.invalid_payload', async () => {
    const { boundary } = boundaryOver({
      kind: 'failure',
      requestId: 'r',
      correlationId: 'c',
      code: 'validation.invalid_payload',
      message: 'Bot not found',
      retryable: false,
      details: { errorCode: 'not_found.resource' },
    });

    const loaded = await loadAgentEvidence(boundary, 'get_owner_bot_fills', { botId: 'nope' }, 'fills', toFillRow);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe('not_found.resource');
  });

  it('passes a non-validation failure code through unchanged', async () => {
    const { boundary } = boundaryOver({
      kind: 'failure',
      requestId: 'r',
      correlationId: 'c',
      code: 'authorization.denied',
      message: 'not allowed',
      retryable: false,
      details: { errorCode: 'not_found.resource' },
    });

    const loaded = await loadAgentEvidence(boundary, 'get_owner_bot_fills', { botId: 'bot-1' }, 'fills', toFillRow);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe('authorization.denied');
  });

  it('keeps validation.invalid_payload when there is no details.errorCode', async () => {
    const { boundary } = boundaryOver({
      kind: 'failure',
      requestId: 'r',
      correlationId: 'c',
      code: 'validation.invalid_payload',
      message: 'genuinely invalid payload',
      retryable: false,
    });

    const loaded = await loadAgentEvidence(boundary, 'get_owner_bot_fills', { botId: 'bot-1' }, 'fills', toFillRow);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe('validation.invalid_payload');
  });
});

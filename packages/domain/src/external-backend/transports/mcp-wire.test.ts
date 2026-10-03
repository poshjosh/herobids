import { describe, expect, it } from 'vitest';
import type { ExternalBackendFailureCode, ExternalBackendToolResultV1 } from '../contract.js';
import { decodeCallToolResult, decodeMcpError, type McpErrorSdk } from './mcp-wire.js';

const CLOSED_CODES: ExternalBackendFailureCode[] = [
  'validation.invalid_payload',
  'authentication.invalid_caller',
  'authorization.denied',
  'not_found.resource',
  'precondition.not_ready',
  'rate_limit.exceeded',
  'deadline.expired',
  'upstream.transient',
  'internal.non_retryable',
  'contract.unsupported_version',
];

function failureResult(code: string): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: 'r',
    correlationId: 'c',
    outcome: { kind: 'failure', code, message: 'm', retryable: false },
  };
}

// Minimal stand-ins for the SDK error classes (instanceof is all the decoder uses).
class FakeProtocolError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
  }
}
class FakeSdkHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
const SDK: McpErrorSdk = { ProtocolError: FakeProtocolError, SdkHttpError: FakeSdkHttpError };

describe('decodeCallToolResult', () => {
  it('accepts each closed-union failure code and rejects an unknown code', () => {
    for (const code of CLOSED_CODES) {
      const outcome = decodeCallToolResult({ structuredContent: failureResult(code), isError: true });
      expect(outcome.kind).toBe('terminal');
      if (outcome.kind === 'terminal') {
        expect(outcome.result.outcome.kind).toBe('failure');
      }
    }

    const unknown = decodeCallToolResult({ structuredContent: failureResult('mystery.code'), isError: true });
    expect(unknown).toEqual({ kind: 'transport_error', message: 'boundary returned an unreadable response' });
  });

  it('maps a success structuredContent (isError absent) to a terminal success', () => {
    const outcome = decodeCallToolResult({
      structuredContent: { contractVersion: '1.0', requestId: 'r', correlationId: 'c', outcome: { kind: 'success', payload: { ok: true } } },
    });
    expect(outcome).toEqual({
      kind: 'terminal',
      result: { contractVersion: '1.0', requestId: 'r', correlationId: 'c', outcome: { kind: 'success', payload: { ok: true } } } satisfies ExternalBackendToolResultV1,
    });
  });

  it('reports an in_progress status shape as in_progress', () => {
    const outcome = decodeCallToolResult({
      structuredContent: { contractVersion: '1.0', requestId: 'r9', correlationId: 'c9', state: 'in_progress' },
    });
    expect(outcome).toEqual({ kind: 'in_progress', requestId: 'r9', correlationId: 'c9' });
  });

  it('unwraps a terminal status into its result', () => {
    const result: ExternalBackendToolResultV1 = {
      contractVersion: '1.0',
      requestId: 'r5',
      correlationId: 'c5',
      outcome: { kind: 'success', payload: { done: true } },
    };
    const outcome = decodeCallToolResult({
      structuredContent: { contractVersion: '1.0', requestId: 'r5', correlationId: 'c5', state: 'terminal', result },
    });
    expect(outcome).toEqual({ kind: 'terminal', result });
  });

  it('treats a missing or malformed structuredContent as an unreadable response', () => {
    for (const content of [undefined, null, 42, {}, { outcome: null }]) {
      expect(decodeCallToolResult({ structuredContent: content })).toEqual({
        kind: 'transport_error',
        message: 'boundary returned an unreadable response',
      });
    }
  });

  it('treats an isError flag that disagrees with the outcome as unreadable', () => {
    // Success result but isError true.
    expect(
      decodeCallToolResult({
        structuredContent: { contractVersion: '1.0', requestId: 'r', correlationId: 'c', outcome: { kind: 'success', payload: null } },
        isError: true,
      }),
    ).toEqual({ kind: 'transport_error', message: 'boundary returned an unreadable response' });
    // Failure result but isError absent/false.
    expect(decodeCallToolResult({ structuredContent: failureResult('upstream.transient') })).toEqual({
      kind: 'transport_error',
      message: 'boundary returned an unreadable response',
    });
    // Status shape must not carry isError.
    expect(
      decodeCallToolResult({ structuredContent: { contractVersion: '1.0', requestId: 'r', correlationId: 'c', state: 'in_progress' }, isError: true }),
    ).toEqual({ kind: 'transport_error', message: 'boundary returned an unreadable response' });
  });
});

describe('decodeMcpError', () => {
  it('maps a ProtocolError carrying a failure envelope to that terminal failure', () => {
    const err = new FakeProtocolError(-32000, 'denied', failureResult('authorization.denied'));
    const outcome = decodeMcpError(err, SDK);
    expect(outcome.kind).toBe('terminal');
    if (outcome.kind === 'terminal') {
      expect(outcome.result.outcome).toMatchObject({ kind: 'failure', code: 'authorization.denied' });
    }
  });

  it('maps a ProtocolError without a decodable envelope to a transport error', () => {
    const err = new FakeProtocolError(-32603, 'boundary internal error', 'opaque');
    expect(decodeMcpError(err, SDK)).toEqual({ kind: 'transport_error', message: 'request to boundary failed' });
  });

  it('maps an HTTP error to its status', () => {
    expect(decodeMcpError(new FakeSdkHttpError(503, 'unavailable'), SDK)).toEqual({
      kind: 'transport_error',
      message: 'boundary returned status 503',
    });
  });

  it('maps any other thrown value to a generic request failure', () => {
    expect(decodeMcpError(new Error('ECONNREFUSED'), SDK)).toEqual({
      kind: 'transport_error',
      message: 'request to boundary failed',
    });
  });
});

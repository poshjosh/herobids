// MCP wire decoding (Step 10 plan §2.5; Phase 3 T2.3). Turns the SDK's
// `CallToolResult` — or a thrown SDK error — into the transport-neutral
// `TransportOutcome` the client maps. Pure decode + classification: no I/O, no
// signing, no deadline arithmetic (those stay in the transport/client).
//
// The SDK validates `CallToolResult` with its own (nested zod 4) codec, but the
// 005 envelope carried in `structuredContent` is app-owned and unvalidated by
// the SDK, so it is decoded here with app-code zod 3. The failure-code enum is
// a CLOSED copy of `ExternalBackendFailureCode`; the `satisfies` below fails to
// compile if the two ever drift, so the closed union stays closed on the wire.

import { z } from 'zod';
import type {
  ExternalBackendFailureCode,
  ExternalBackendToolResultV1,
} from '../contract.js';
import type { TransportOutcome } from './transport.js';

// Messages are RestTransport's, so a transport fault reads identically on both.
const UNREADABLE_RESPONSE_MESSAGE = 'boundary returned an unreadable response';
const REQUEST_FAILED_MESSAGE = 'request to boundary failed';

/** The 005 closed failure-code enum, re-stated for zod-3 decode. */
const FAILURE_CODES = [
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
] as const;
// Compile-time guard: the enum is exactly the contract union (no drift).
type DecodedFailureCode = (typeof FAILURE_CODES)[number];
const _codesAreClosed: readonly ExternalBackendFailureCode[] = FAILURE_CODES satisfies readonly DecodedFailureCode[];
void _codesAreClosed;

const FailureCodeSchema = z.enum(FAILURE_CODES);

const OutcomeSchema = z.discriminatedUnion('kind', [
  // `payload` may be absent: the backend's `successResult(id, result.data)` can
  // carry `undefined`, which JSON drops — an absent key is a valid success.
  z.object({ kind: z.literal('success'), payload: z.unknown() }),
  z.object({
    kind: z.literal('failure'),
    code: FailureCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
]);

// The transform re-asserts the exact contract shape: zod widens an absent
// `payload` to optional, but `ExternalBackendSuccessOutcome.payload` is a
// present `unknown` (an omitted key is a valid `undefined` payload), so the
// success branch is normalized to always carry the key.
const ToolResultWireSchema = z
  .object({
    contractVersion: z.literal('1.0'),
    requestId: z.string(),
    correlationId: z.string(),
    outcome: OutcomeSchema,
  })
  .transform((parsed): ExternalBackendToolResultV1 => {
    const { outcome } = parsed;
    const normalized: ExternalBackendToolResultV1['outcome'] =
      outcome.kind === 'success'
        ? { kind: 'success', payload: outcome.payload }
        : {
            kind: 'failure',
            code: outcome.code,
            message: outcome.message,
            retryable: outcome.retryable,
            ...(outcome.details ? { details: outcome.details } : {}),
          };
    return {
      contractVersion: parsed.contractVersion,
      requestId: parsed.requestId,
      correlationId: parsed.correlationId,
      outcome: normalized,
    };
  });

const StatusWireSchema = z.discriminatedUnion('state', [
  z.object({
    contractVersion: z.literal('1.0'),
    requestId: z.string(),
    correlationId: z.string(),
    state: z.literal('in_progress'),
  }),
  z.object({
    contractVersion: z.literal('1.0'),
    requestId: z.string(),
    correlationId: z.string(),
    state: z.literal('terminal'),
    result: ToolResultWireSchema,
  }),
]);

/** The shape of `CallToolResult` this decoder reads (a narrowing of the SDK type). */
export interface DecodableCallToolResult {
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * The SDK error classes used to classify a thrown rejection. `instanceof` on
 * these is brand-matched by the SDK, so it works across separately bundled
 * copies. The lazily-loaded `@modelcontextprotocol/client` module satisfies this.
 */
export interface McpErrorSdk {
  // Brand markers for `instanceof` only — never constructed here (the `never[]`
  // constructor shape makes that explicit).
  ProtocolError: new (...args: never[]) => { code: number; data?: unknown };
  SdkHttpError: new (...args: never[]) => { status: number };
}

function transportError(message: string): TransportOutcome {
  return { kind: 'transport_error', message };
}

function terminal(result: ExternalBackendToolResultV1): TransportOutcome {
  return { kind: 'terminal', result };
}

/**
 * Decode a `tools/call` result (n25). `structuredContent` carries either a
 * status shape (same-key re-issue) or the terminal 005 result. `isError` MUST
 * agree with the outcome kind; a disagreement, a missing or malformed
 * `structuredContent`, or an `isError` on a status shape is an unreadable
 * response (never a thrown decode error).
 */
export function decodeCallToolResult(result: DecodableCallToolResult): TransportOutcome {
  const content: unknown = result.structuredContent;

  const status = StatusWireSchema.safeParse(content);
  if (status.success) {
    // A status shape never carries isError (it is not a failure outcome).
    if (result.isError === true) return transportError(UNREADABLE_RESPONSE_MESSAGE);
    if (status.data.state === 'in_progress') {
      return { kind: 'in_progress', requestId: status.data.requestId, correlationId: status.data.correlationId };
    }
    return terminal(status.data.result);
  }

  const toolResult = ToolResultWireSchema.safeParse(content);
  if (toolResult.success) {
    const isFailure = toolResult.data.outcome.kind === 'failure';
    // n25: isError is true iff the outcome is a failure. A mismatch is a
    // backend contract violation we cannot trust — surface it as unreadable.
    if ((result.isError === true) !== isFailure) return transportError(UNREADABLE_RESPONSE_MESSAGE);
    return terminal(toolResult.data);
  }

  return transportError(UNREADABLE_RESPONSE_MESSAGE);
}

/**
 * Decode a thrown SDK error (connect/callTool rejection) into a transport
 * outcome. A `ProtocolError` whose `data` is a 005 failure result is a terminal
 * failure the backend chose to signal as a JSON-RPC error (n26); an HTTP error
 * carries its status; anything else is an opaque request failure. Never throws.
 */
export function decodeMcpError(err: unknown, sdk: McpErrorSdk): TransportOutcome {
  // SdkHttpError and ProtocolError are disjoint siblings, so the check order
  // does not matter.
  if (err instanceof sdk.SdkHttpError) {
    return transportError(`boundary returned status ${err.status}`);
  }
  if (err instanceof sdk.ProtocolError) {
    const decoded = ToolResultWireSchema.safeParse(err.data);
    if (decoded.success) return terminal(decoded.data);
    return transportError(REQUEST_FAILED_MESSAGE);
  }
  return transportError(REQUEST_FAILED_MESSAGE);
}

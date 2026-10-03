// The Traderton REST boundary client (005-consumer-boundary-contract.md).
//
// A small `fetch`-based client: it builds the 005 invocation envelope, signs it
// (HMAC via ./sign), POSTs `tools:invoke`, polls `GET invocations/:requestId`,
// and maps the boundary response into a typed discriminated-union result the
// caller can branch on. Transport + envelope + mapping ONLY — it authors no
// trading behaviour (no risk/planner/executor). The platform injects the
// subject/caller VALUES at the call site.
//
// Nothing in production calls this yet (L3b/L3c wire it). This slice ADDS the
// client + its config + tests against a stubbed boundary.

import { randomUUID } from 'node:crypto';
import {
  signInvoke,
  signStatus,
  type SigningIdentity,
} from './sign.js';
import {
  TRADERTON_INVOKE_PATH,
  tradertonStatusPath,
  type TradertonToolInvocationV1,
  type TradertonToolResultV1,
  type TradertonToolInvocationStatusV1,
  type TradertonSubject,
  type TradertonCaller,
  type TradertonBoundaryFailureCode,
  type TradertonOutcome,
} from './contract.js';
import { deriveRequestId } from './request-id.js';

/** Operator config the client needs (subset of the domain BoundaryConfig). */
export interface TradertonClientConfig {
  baseUrl: string;
  consumerId: string;
  keyId: string;
  hmacSecret: string;
  requestTimeoutMs: number;
}

/** Inputs for a single tool invocation. Platform-owned values are injected here. */
export interface InvokeToolInput {
  toolName: string;
  payload: unknown;
  subject: TradertonSubject;
  /**
   * The deadline for this call. Provide either an absolute RFC3339 `deadlineAt`
   * or a `deadlineMs` duration from now (used to derive `deadlineAt`).
   */
  deadlineAt?: string;
  deadlineMs?: number;
  /**
   * Idempotency/correlation identifiers (005 §Deadlines/Retries: a transport
   * retry MUST reuse the same requestId + idempotencyKey). `idempotencyKey` is
   * optional because this client also serves reads; every WRITE must supply one
   * stable key per logical write. With a key and no explicit `requestId`, the
   * `requestId` is derived from the key (`deriveRequestId`), so every re-issue of
   * that write carries the same `requestId`. Without a key, all three are fresh
   * randomUUIDs.
   */
  requestId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  issuedAt?: string;
}

/**
 * The typed client result — a discriminated union the caller branches on.
 * A local union (not the domain `Result<T,E>`) is clearer here because the
 * boundary distinguishes THREE terminal-ish shapes plus a transport failure,
 * and callers must preserve the failure `code` + `retryable` verbatim.
 */
export type TradertonClientResult =
  | { kind: 'success'; requestId: string; correlationId: string; payload: unknown }
  | {
      kind: 'failure';
      requestId: string;
      correlationId: string;
      code: TradertonBoundaryFailureCode;
      message: string;
      retryable: boolean;
      details?: Record<string, unknown>;
    }
  | { kind: 'in_progress'; requestId: string; correlationId: string }
  /**
   * A transport/client-side failure (fetch rejected, non-2xx, unparseable body,
   * timeout, or no terminal response). Distinct + retryable so the caller can
   * decide whether to poll/retry within the deadline. Never leaks boundary
   * internals or stack traces.
   */
  | { kind: 'transport_error'; requestId: string; retryable: true; message: string };

/** Options for polling the status endpoint. */
export interface PollOptions {
  /** Absolute deadline (RFC3339). Polling stops with a timeout error once passed. */
  deadlineAt: string;
  correlationId?: string;
  /** Interval between status polls (ms). Default 1000. */
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const UNRECOGNISED_STATUS_MESSAGE = 'boundary returned an unrecognised status response';
const UNRECOGNISED_RESPONSE_MESSAGE = 'boundary returned an unrecognised response';

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Map a terminal `TradertonToolResultV1` outcome into the client result union. */
function mapTerminalResult(result: TradertonToolResultV1): TradertonClientResult {
  const outcome: TradertonOutcome = result.outcome;
  if (outcome.kind === 'success') {
    return {
      kind: 'success',
      requestId: result.requestId,
      correlationId: result.correlationId,
      payload: outcome.payload,
    };
  }
  return {
    kind: 'failure',
    requestId: result.requestId,
    correlationId: result.correlationId,
    code: outcome.code,
    message: outcome.message,
    retryable: outcome.retryable,
    ...(outcome.details ? { details: outcome.details } : {}),
  };
}

// invoke and poll read unvalidated JSON, so they check shape before mapping: a
// body they do not recognise is a transport fault, never a TypeError thrown out.
// A status body must carry one of the two known states.
function hasStringIds(value: object): boolean {
  return (
    'requestId' in value &&
    typeof value.requestId === 'string' &&
    'correlationId' in value &&
    typeof value.correlationId === 'string'
  );
}

function isStatusBody(value: unknown): value is TradertonToolInvocationStatusV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    hasStringIds(value) &&
    'state' in value &&
    (value.state === 'in_progress' || value.state === 'terminal')
  );
}

function isOutcome(value: unknown): value is TradertonOutcome {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  // No `payload` check: the backend's `successResult(identity, result.data)`
  // may carry `undefined`, which JSON drops, so an absent key is a valid success.
  if (value.kind === 'success') return true;
  return (
    value.kind === 'failure' &&
    'code' in value &&
    typeof value.code === 'string' &&
    'message' in value &&
    typeof value.message === 'string' &&
    'retryable' in value &&
    typeof value.retryable === 'boolean'
  );
}

function isToolResultBody(value: unknown): value is TradertonToolResultV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    hasStringIds(value) &&
    'outcome' in value &&
    isOutcome(value.outcome)
  );
}

/**
 * The Traderton REST boundary client. Construct once with operator config +
 * signing identity; call `invoke` per tool call and `poll` to resolve an
 * ambiguous/async invocation.
 */
export class TradertonClient {
  private readonly baseUrl: string;
  private readonly identity: SigningIdentity;
  private readonly requestTimeoutMs: number;

  constructor(config: TradertonClientConfig) {
    // Trim a trailing slash so `${baseUrl}${path}` never doubles it.
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.identity = {
      consumerId: config.consumerId,
      keyId: config.keyId,
      secret: config.hmacSecret,
    };
    this.requestTimeoutMs = config.requestTimeoutMs;
  }

  private caller(): TradertonCaller {
    return { consumerId: this.identity.consumerId, keyId: this.identity.keyId };
  }

  /** Build the 005 invocation envelope, generating identifiers where not supplied. */
  buildEnvelope(input: InvokeToolInput): TradertonToolInvocationV1 {
    const issuedAt = input.issuedAt ?? nowIso();
    const deadlineAt =
      input.deadlineAt ??
      new Date(Date.now() + (input.deadlineMs ?? this.requestTimeoutMs)).toISOString();

    const requestId =
      input.requestId ??
      (input.idempotencyKey !== undefined
        ? deriveRequestId({
            consumerId: this.identity.consumerId,
            ownerId: input.subject.ownerId,
            toolName: input.toolName,
            idempotencyKey: input.idempotencyKey,
          })
        : randomUUID());

    return {
      contractVersion: '1.0',
      requestId,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      correlationId: input.correlationId ?? randomUUID(),
      issuedAt,
      deadlineAt,
      caller: this.caller(),
      subject: input.subject,
      toolName: input.toolName,
      payload: input.payload,
    };
  }

  /**
   * Invoke a tool: build → sign → POST → map. Returns the typed result union.
   * A transport failure or non-terminal/unparseable response is surfaced as the
   * distinct `transport_error` variant (never thrown raw).
   */
  async invoke(input: InvokeToolInput): Promise<TradertonClientResult> {
    const envelope = this.buildEnvelope(input);
    const { headers, rawBody } = signInvoke(this.identity, TRADERTON_INVOKE_PATH, envelope);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${TRADERTON_INVOKE_PATH}`, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      return this.transportError(envelope.requestId, 'request to boundary failed');
    }

    return this.parseInvokeResponse(response, envelope.requestId);
  }

  private async parseInvokeResponse(
    response: Response,
    requestId: string,
  ): Promise<TradertonClientResult> {
    if (!response.ok) {
      return this.transportError(requestId, `boundary returned status ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return this.transportError(requestId, 'boundary returned an unreadable response');
    }

    if (isStatusBody(body)) {
      if (body.state === 'in_progress') {
        return { kind: 'in_progress', requestId: body.requestId, correlationId: body.correlationId };
      }
      return isToolResultBody(body.result)
        ? mapTerminalResult(body.result)
        : this.transportError(requestId, UNRECOGNISED_RESPONSE_MESSAGE);
    }
    return isToolResultBody(body)
      ? mapTerminalResult(body)
      : this.transportError(requestId, UNRECOGNISED_RESPONSE_MESSAGE);
  }

  /**
   * Poll `GET /internal/v1/invocations/:requestId` (signed, empty body) until
   * the invocation reaches a terminal outcome, or the deadline passes. Resolves
   * to the terminal result on completion, or a transport/timeout error once the
   * deadline is exceeded. Exposed for the L3c synchronous-feel rewire — NOT
   * wired to submit_decision here.
   */
  async poll(requestId: string, opts: PollOptions): Promise<TradertonClientResult> {
    const path = tradertonStatusPath(requestId);
    const url = `${this.baseUrl}${path}`;
    const deadlineMs = Date.parse(opts.deadlineAt);
    const intervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const correlationId = opts.correlationId ?? requestId;

    for (;;) {
      if (!Number.isNaN(deadlineMs) && Date.now() >= deadlineMs) {
        return {
          kind: 'failure',
          requestId,
          correlationId,
          code: 'deadline.expired',
          message: 'deadline passed before the invocation reached a terminal outcome',
          retryable: false,
        };
      }

      const headers = signStatus(this.identity, path, { deadlineAt: opts.deadlineAt });

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch {
        return this.transportError(requestId, 'status request to boundary failed');
      }

      if (!response.ok) {
        return this.transportError(requestId, `boundary returned status ${response.status}`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return this.transportError(requestId, 'boundary returned an unreadable status response');
      }

      if (!isStatusBody(body)) {
        // A plain result (no `state`) is the boundary answering for the lookup
        // itself — e.g. `not_found.resource` when it has no record of the
        // requestId. It is terminal: return it rather than polling to the deadline.
        // An unknown `state` is unrecognised, never polled to the deadline.
        return isToolResultBody(body)
          ? mapTerminalResult(body)
          : this.transportError(requestId, UNRECOGNISED_STATUS_MESSAGE);
      }
      if (body.state === 'terminal') {
        return isToolResultBody(body.result)
          ? mapTerminalResult(body.result)
          : this.transportError(requestId, UNRECOGNISED_STATUS_MESSAGE);
      }

      // Still in progress — wait, but never sleep past the deadline.
      const remaining = Number.isNaN(deadlineMs) ? intervalMs : deadlineMs - Date.now();
      if (remaining <= 0) {
        continue; // loop re-checks the deadline and returns the timeout error
      }
      await sleep(Math.min(intervalMs, remaining));
    }
  }

  private transportError(
    requestId: string,
    message: string,
  ): Extract<TradertonClientResult, { kind: 'transport_error' }> {
    return { kind: 'transport_error', requestId, retryable: true, message };
  }
}

/** Factory mirroring the herobids per-use-helper norm. */
export function createTradertonClient(config: TradertonClientConfig): TradertonClient {
  return new TradertonClient(config);
}

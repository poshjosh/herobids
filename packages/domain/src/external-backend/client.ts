// The external-backend boundary client (005-consumer-boundary-contract.md).
//
// Builds the 005 invocation envelope and orchestrates every call above the
// internal transport seam (Step 10 plan §2.4): identifiers, deadlines, the
// same-key reconcile of an unknown write outcome, and the mapping into a typed
// discriminated-union result the caller can branch on. The transport chosen per
// tool (./transports/select-transport) only encodes, signs, sends and decodes.
// Transport + envelope + mapping ONLY — it authors no trading behaviour (no
// risk/planner/executor). The platform injects the subject/caller VALUES at the
// call site.
//
// `invoke` is also the single metrics seam: it emits one
// `ExternalBackendInvocationSample` per invocation through an injected
// `MetricsSink` (default no-op). See docs/tech/observability.md.

import { randomUUID } from 'node:crypto';
import type { SigningIdentity } from './sign.js';
import {
  NOOP_METRICS_SINK,
  type MetricsSink,
  type ExternalBackendInvocationSample,
} from './metrics.js';
import type {
  ExternalBackendToolInvocationV1,
  ExternalBackendToolResultV1,
  ExternalBackendSubject,
  ExternalBackendCaller,
  ExternalBackendFailureCode,
  ExternalBackendOutcome,
} from './contract.js';
import { deriveRequestId } from './request-id.js';
import {
  DEFAULT_EXTERNAL_BACKEND_PROTOCOL,
  type ExternalBackendProtocol,
} from '../config/external-backends.js';
import { createTransportSelector, type TransportForTool } from './transports/select-transport.js';
import type { TransportOutcome } from './transports/transport.js';

/** Operator config the client needs (built from an ExternalBackendDefinition + resolved secret). */
export interface ExternalBackendClientConfig {
  baseUrl: string;
  consumerId: string;
  keyId: string;
  hmacSecret: string;
  requestTimeoutMs: number;
  /** Endpoint protocol for every tool without an override. Default `rest`. */
  protocol?: ExternalBackendProtocol;
  /** Per-tool protocol; absent tools use `protocol`. */
  toolProtocolOverrides?: Readonly<Record<string, ExternalBackendProtocol>>;
  /** MCP endpoint path; required by the definition schema whenever `mcp` is used. */
  mcpPath?: string;
  /** Sink for invocation metrics; defaults to a no-op (see docs/tech/observability.md). */
  metrics?: MetricsSink;
  /** Identifies the backend in emitted samples; defaults to `'unknown'`. */
  backendId?: string;
}

/** Inputs for a single tool invocation. Platform-owned values are injected here. */
export interface InvokeToolInput {
  toolName: string;
  payload: unknown;
  subject: ExternalBackendSubject;
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
 * Inputs for `invokeAndAwait`: one logical WRITE. The key is required because
 * an unknown outcome is reconciled by re-issuing under the same key; a fresh
 * key per attempt would make the re-issue a second write.
 */
export type InvokeAndAwaitInput = InvokeToolInput & { deadlineAt: string; idempotencyKey: string };

/**
 * The typed client result — a discriminated union the caller branches on.
 * A local union (not the domain `Result<T,E>`) is clearer here because the
 * boundary distinguishes THREE terminal-ish shapes plus a transport failure,
 * and callers must preserve the failure `code` + `retryable` verbatim.
 */
export type ExternalBackendClientResult =
  | { kind: 'success'; requestId: string; correlationId: string; payload: unknown }
  | {
      kind: 'failure';
      requestId: string;
      correlationId: string;
      code: ExternalBackendFailureCode;
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
  /** Selects whose transport's status lookup is used; absent → the endpoint protocol. */
  toolName?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const STATUS_LOOKUP_UNSUPPORTED_MESSAGE =
  'status lookup is not supported by this backend transport; re-issue the invocation with the same idempotency key';

type InProgressResult = Extract<ExternalBackendClientResult, { kind: 'in_progress' }>;

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Map a terminal `ExternalBackendToolResultV1` outcome into the client result union. */
function mapTerminalResult(result: ExternalBackendToolResultV1): ExternalBackendClientResult {
  const outcome: ExternalBackendOutcome = result.outcome;
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

/**
 * True for a poll (or re-issue) answer that describes the lookup/request rather than the write:
 * the client's own deadline stop (`deadline.expired`), no row for the requestId
 * (`not_found.resource`), or a rejected status request (`authentication.*`). A
 * stored write result never carries these codes: both backend deadline checks
 * (traderton dispatcher.ts steps 1b and 7) run before `beginOrResolve`, HMAC
 * authentication runs in app.ts before dispatch, and `mapToolResult` maps a
 * tool's `not_found.resource` errorCode to `validation.invalid_payload`.
 */
function isLookupLevelAnswer(result: ExternalBackendClientResult): boolean {
  return (
    result.kind === 'failure' &&
    (result.code === 'deadline.expired' ||
      result.code === 'not_found.resource' ||
      result.code.startsWith('authentication.'))
  );
}

/** `Date.parse` of an RFC3339 deadline; NaN means "no usable deadline" (never expires). */
function hasPassed(deadlineMs: number): boolean {
  return !Number.isNaN(deadlineMs) && Date.now() >= deadlineMs;
}

/** Time left before the deadline, or the full interval when there is no usable deadline. */
function remainingBefore(deadlineMs: number, intervalMs: number): number {
  return Number.isNaN(deadlineMs) ? intervalMs : deadlineMs - Date.now();
}

/**
 * The external-backend boundary client. Construct once with operator config +
 * signing identity; call `invoke` per tool call, `poll` to resolve an
 * ambiguous/async invocation, and `invokeAndAwait` for a write that must be
 * reconciled to a terminal outcome within its deadline.
 */
export class ExternalBackendClient {
  private readonly identity: SigningIdentity;
  private readonly requestTimeoutMs: number;
  private readonly selectTransport: TransportForTool;
  private readonly metrics: MetricsSink;
  private readonly backendId: string;

  constructor(config: ExternalBackendClientConfig) {
    this.identity = {
      consumerId: config.consumerId,
      keyId: config.keyId,
      secret: config.hmacSecret,
    };
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.metrics = config.metrics ?? NOOP_METRICS_SINK;
    this.backendId = config.backendId ?? 'unknown';
    this.selectTransport = createTransportSelector({
      // Trim a trailing slash so `${baseUrl}${path}` never doubles it.
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      identity: this.identity,
      protocol: config.protocol ?? DEFAULT_EXTERNAL_BACKEND_PROTOCOL,
      toolProtocolOverrides: config.toolProtocolOverrides,
      mcpPath: config.mcpPath,
    });
  }

  private caller(): ExternalBackendCaller {
    return { consumerId: this.identity.consumerId, keyId: this.identity.keyId };
  }

  /**
   * The per-attempt transport timeout (P3-18 resolution; IV-2). It is the
   * smaller of the client's `requestTimeoutMs` and the time left to
   * `deadlineAt`, falling back to the full `requestTimeoutMs` once the deadline
   * has already passed or is unusable — the backend then answers
   * `deadline.expired` rather than the attempt being clipped to zero. ONE method
   * for both transports: for MCP it bounds the whole exchange; for REST it only
   * ever shortens an attempt, so no transport-aware deadline arithmetic leaks
   * below the seam.
   */
  private attemptTimeoutMs(deadlineAt: string): number {
    const deadlineMs = Date.parse(deadlineAt);
    if (Number.isNaN(deadlineMs)) return this.requestTimeoutMs;
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return this.requestTimeoutMs;
    return Math.min(this.requestTimeoutMs, remaining);
  }

  /** Build the 005 invocation envelope, generating identifiers where not supplied. */
  buildEnvelope(input: InvokeToolInput): ExternalBackendToolInvocationV1 {
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
   * Invoke a tool: build → send through the tool's transport → map. Returns the
   * typed result union. A transport failure or non-terminal/unparseable response
   * is surfaced as the distinct `transport_error` variant (never thrown raw).
   */
  async invoke(input: InvokeToolInput): Promise<ExternalBackendClientResult> {
    const envelope = this.buildEnvelope(input);
    const start = Date.now();
    const outcome = await this.selectTransport(envelope.toolName).invoke(envelope, {
      timeoutMs: this.attemptTimeoutMs(envelope.deadlineAt),
    });
    const result = this.mapOutcome(outcome, envelope.requestId);
    this.recordInvocationSample(envelope, result, Date.now() - start);
    return result;
  }

  /**
   * Emit exactly one metrics sample per invocation (see docs/tech/observability.md).
   * A sink error can never alter or block the returned result, so emission is
   * wrapped in a swallowing try/catch.
   */
  private recordInvocationSample(
    envelope: ExternalBackendToolInvocationV1,
    result: ExternalBackendClientResult,
    durationMs: number,
  ): void {
    const sample: ExternalBackendInvocationSample = {
      backendId: this.backendId,
      toolName: envelope.toolName,
      outcome: result.kind,
      durationMs,
      requestId: envelope.requestId,
      correlationId: envelope.correlationId,
      ...(result.kind === 'failure' ? { code: result.code, retryable: result.retryable } : {}),
      ...(result.kind === 'transport_error' ? { retryable: true } : {}),
    };
    try {
      this.metrics.recordInvocation(sample);
    } catch {
      // Swallow — a metrics sink failure must never change a trading result.
    }
  }

  /**
   * Invoke one logical write and reconcile it to a terminal outcome within
   * `deadlineAt` (Phase 3 T0.6 D-e; moved here from the worker write adapter,
   * P3-20). On an unknown outcome (`transport_error`) while the deadline has
   * not passed, re-issue ONCE with the identical input; never re-issue after a
   * terminal outcome. Then resolve `in_progress` through the transport's status
   * lookup, or — when it has none — by re-issuing the same invocation until it
   * settles. A write still running at the deadline stays `in_progress`
   * (unknown outcome), never a rejection.
   */
  async invokeAndAwait(
    input: InvokeAndAwaitInput,
    opts: { pollIntervalMs?: number } = {},
  ): Promise<ExternalBackendClientResult> {
    // Without a usable deadline nothing bounds the reconcile loop; refuse
    // before sending anything (nothing was written).
    if (Number.isNaN(Date.parse(input.deadlineAt))) {
      return {
        kind: 'failure',
        requestId: input.requestId ?? '',
        correlationId: input.correlationId ?? '',
        code: 'validation.invalid_payload',
        message: 'invokeAndAwait requires an RFC3339 deadlineAt',
        retryable: false,
      };
    }
    // One input for every attempt: same key, same derived requestId, same
    // payload, same deadline, one correlationId for the whole logical write.
    const invokeInput: InvokeAndAwaitInput = {
      ...input,
      correlationId: input.correlationId ?? randomUUID(),
    };

    let result = await this.invoke(invokeInput);

    // Unknown outcome (the request or its response was lost). A same-key
    // re-issue is at-most-once on the backend: it replays a stored result,
    // reports in_progress, or executes once if the first never arrived. Worst
    // case it overruns `deadlineAt` by one client request timeout.
    if (result.kind === 'transport_error' && Date.now() < Date.parse(invokeInput.deadlineAt)) {
      const reissued = await this.invoke(invokeInput);
      // deadline.expired and authentication.* are answered BEFORE the
      // idempotency lookup, and not_found.resource is never a stored write
      // result, so such a re-issue answer says nothing about the first
      // attempt — the outcome is still unknown; keep the original error.
      if (!isLookupLevelAnswer(reissued)) {
        result = reissued;
      }
    }

    // Terminal (never re-issued — D-a) or still unknown.
    if (result.kind !== 'in_progress') {
      return result;
    }

    // Non-terminal — resolve to the shared deadline for the synchronous feel (D3).
    const resolved = await this.awaitTerminal(invokeInput, result, opts.pollIntervalMs);
    // The write was seen running, and the backend gates the deadline only
    // BEFORE execution, so it may still complete after our deadline. A
    // lookup-level answer says nothing about it: the outcome is unknown, not a
    // rejection (callers map `failure` to a recorded rejection).
    if (isLookupLevelAnswer(resolved)) {
      return { kind: 'in_progress', requestId: result.requestId, correlationId: result.correlationId };
    }
    return resolved;
  }

  /** Resolve a running write by the transport's capability: status lookup, else same-key re-issue (D15). */
  private async awaitTerminal(
    input: InvokeAndAwaitInput,
    inProgress: InProgressResult,
    pollIntervalMs: number | undefined,
  ): Promise<ExternalBackendClientResult> {
    if (this.selectTransport(input.toolName).lookupStatus) {
      return this.poll(inProgress.requestId, {
        deadlineAt: input.deadlineAt,
        correlationId: inProgress.correlationId,
        toolName: input.toolName,
        ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
      });
    }

    const deadlineMs = Date.parse(input.deadlineAt);
    // Every iteration re-issues a write, so a zero/negative/NaN interval must
    // not turn this into back-to-back requests.
    const intervalMs =
      pollIntervalMs !== undefined && Number.isFinite(pollIntervalMs) && pollIntervalMs >= 1
        ? pollIntervalMs
        : DEFAULT_POLL_INTERVAL_MS;
    for (;;) {
      // Never sleep past the deadline, and never re-issue once it has passed (T0.6 R1).
      await sleep(Math.max(0, Math.min(intervalMs, remainingBefore(deadlineMs, intervalMs))));
      if (hasPassed(deadlineMs)) {
        return this.deadlineExpired(inProgress.requestId, inProgress.correlationId);
      }
      const reissued = await this.invoke(input);
      if (reissued.kind !== 'in_progress') {
        return reissued;
      }
    }
  }

  /**
   * Poll the tool's transport status lookup (REST: signed
   * `GET /internal/v1/invocations/:requestId`) until the invocation reaches a
   * terminal outcome, or the deadline passes. Resolves to the terminal result
   * on completion, or a transport/timeout error once the deadline is exceeded.
   * A transport without a status lookup returns `precondition.not_ready`: the
   * invocation must be re-issued with the same idempotency key instead.
   */
  async poll(requestId: string, opts: PollOptions): Promise<ExternalBackendClientResult> {
    const transport = this.selectTransport(opts.toolName);
    const deadlineMs = Date.parse(opts.deadlineAt);
    const intervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const correlationId = opts.correlationId ?? requestId;

    if (!transport.lookupStatus) {
      return {
        kind: 'failure',
        requestId,
        correlationId,
        code: 'precondition.not_ready',
        message: STATUS_LOOKUP_UNSUPPORTED_MESSAGE,
        retryable: false,
      };
    }

    for (;;) {
      if (hasPassed(deadlineMs)) {
        return this.deadlineExpired(requestId, correlationId);
      }

      const outcome = await transport.lookupStatus(requestId, {
        timeoutMs: this.attemptTimeoutMs(opts.deadlineAt),
        deadlineAt: opts.deadlineAt,
      });
      if (outcome.kind !== 'in_progress') {
        return this.mapOutcome(outcome, requestId);
      }

      // Still in progress — wait, but never sleep past the deadline.
      const remaining = remainingBefore(deadlineMs, intervalMs);
      if (remaining <= 0) {
        continue; // loop re-checks the deadline and returns the timeout error
      }
      await sleep(Math.min(intervalMs, remaining));
    }
  }

  /** Map one transport outcome; `requestId` labels a transport error (the request's own id). */
  private mapOutcome(outcome: TransportOutcome, requestId: string): ExternalBackendClientResult {
    switch (outcome.kind) {
      case 'terminal':
        return mapTerminalResult(outcome.result);
      case 'in_progress':
        return { kind: 'in_progress', requestId: outcome.requestId, correlationId: outcome.correlationId };
      case 'transport_error':
        return this.transportError(requestId, outcome.message);
    }
  }

  private deadlineExpired(requestId: string, correlationId: string): ExternalBackendClientResult {
    return {
      kind: 'failure',
      requestId,
      correlationId,
      code: 'deadline.expired',
      message: 'deadline passed before the invocation reached a terminal outcome',
      retryable: false,
    };
  }

  private transportError(
    requestId: string,
    message: string,
  ): Extract<ExternalBackendClientResult, { kind: 'transport_error' }> {
    return { kind: 'transport_error', requestId, retryable: true, message };
  }
}

/** Factory mirroring the herobids per-use-helper norm. */
export function createExternalBackendClient(config: ExternalBackendClientConfig): ExternalBackendClient {
  return new ExternalBackendClient(config);
}

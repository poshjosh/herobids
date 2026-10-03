// A fake idempotent Traderton boundary for write-path contract tests (Phase 3 T0.6).
//
// NOT a test file: shared by the transport-parameterised contract suite and the
// call-site characterisation tests (no vitest import). It is a hand model of the
// traderton idempotency store; each rule below names the traderton source it
// mirrors so a backend change can be traced here:
//   - D  = traderton packages/boundary/src/dispatcher.ts
//   - R  = traderton packages/db/src/boundary-invocation-repository.ts
//   - A  = traderton packages/boundary/src/app.ts
//   - RS = traderton packages/boundary/src/result.ts
//
// Deliberately NOT modelled: HMAC verification (owned by the T0.3 signing
// vectors), contract-version / tool-registry / payload-schema / authz checks,
// read-only tools bypassing the store (every tool is treated as a write), and
// retention (`expiresAt` is never read by traderton either). The real backend
// fingerprints the Zod-PARSED payload; this fake fingerprints the payload as
// received, which is equal for the already-valid payloads tests send.
//
// The core (`createIdempotentBoundaryCore`) is transport-independent so a
// second face (MCP, T2.3) can sit over the same store. The REST face
// (`startFakeIdempotentBoundary`) is a real node:http server on 127.0.0.1:0.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type {
  ExternalBackendFailureCode,
  ExternalBackendToolInvocationStatusV1,
  ExternalBackendToolInvocationV1,
  ExternalBackendToolResultV1,
} from '@herobids/domain/external-backend';

export type FakeInvokeResponse = ExternalBackendToolResultV1 | ExternalBackendToolInvocationStatusV1;

interface ResultIdentity {
  requestId: string;
  correlationId: string;
}

/** One `boundary_invocations` row (R: schema columns the store reads). */
interface StoredInvocation {
  consumerId: string;
  ownerId: string;
  toolName: string;
  idempotencyKey: string;
  requestFingerprint: string;
  requestId: string;
  correlationId: string;
  state: 'in_progress' | 'terminal';
  terminalResponse: ExternalBackendToolResultV1 | null;
}

/** What one invoke did — lets a transport face decide whether to lose the response. */
export interface CoreInvokeOutcome {
  response: FakeInvokeResponse;
  executed: boolean;
}

export interface IdempotentBoundaryCore {
  invoke(rawBody: unknown): Promise<CoreInvokeOutcome>;
  status(requestId: string): FakeInvokeResponse;
  /** How many times `toolName` actually executed (the durable side-effect count). */
  executions(toolName: string): number;
  /**
   * The next execution waits until the returned release function is called.
   * Releasing also cancels the hold if no execution has consumed it yet.
   */
  holdNextExecution(): () => void;
  /** Resolves the next time a same-key invoke is answered `in_progress`. */
  nextInProgressAnswer(): Promise<void>;
  /** The next execution runs and fails with this outcome, which is stored as its terminal result. */
  failNextExecution(failure: FakeExecutionFailure): void;
  /** The next execution runs but its row is never completed (stays `in_progress`). */
  stallNextCompletion(): void;
}

/** The failure codes an executed write can store (the rest are answered before the store). */
export type FakeStorableFailureCode = Extract<
  ExternalBackendFailureCode,
  | 'rate_limit.exceeded'
  | 'precondition.not_ready'
  | 'upstream.transient'
  | 'validation.invalid_payload'
  | 'internal.non_retryable'
>;

/** A tool-level failure the fake records as an executed write's terminal result. */
export interface FakeExecutionFailure {
  code: FakeStorableFailureCode;
  retryable: boolean;
  message?: string;
}

export interface FakeBoundaryOptions {
  /** Injectable clock for the deadline pre-check (D: `now`). */
  now?: () => number;
}

// RS: successResult / failureResult / inProgressStatus / terminalStatus.
function successResult(identity: ResultIdentity, payload: unknown): ExternalBackendToolResultV1 {
  return { contractVersion: '1.0', ...identity, outcome: { kind: 'success', payload } };
}

function failureResult(
  identity: ResultIdentity,
  code: ExternalBackendFailureCode,
  message: string,
  retryable: boolean,
): ExternalBackendToolResultV1 {
  return { contractVersion: '1.0', ...identity, outcome: { kind: 'failure', code, message, retryable } };
}

function inProgressStatus(identity: ResultIdentity): ExternalBackendToolInvocationStatusV1 {
  return { contractVersion: '1.0', ...identity, state: 'in_progress' };
}

function terminalStatus(identity: ResultIdentity, result: ExternalBackendToolResultV1): ExternalBackendToolInvocationStatusV1 {
  return { contractVersion: '1.0', ...identity, state: 'terminal', result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural envelope check standing in for D step 1 (`TradertonToolInvocationV1Schema`). */
function isInvocationEnvelope(value: unknown): value is ExternalBackendToolInvocationV1 {
  if (!isRecord(value)) return false;
  const stringFields = ['requestId', 'idempotencyKey', 'correlationId', 'issuedAt', 'deadlineAt', 'toolName'];
  const caller = value['caller'];
  const subject = value['subject'];
  return (
    stringFields.every((field) => typeof value[field] === 'string') &&
    isRecord(caller) && typeof caller['consumerId'] === 'string' &&
    isRecord(subject) && typeof subject['ownerId'] === 'string' &&
    'payload' in value
  );
}

/** D step 1 fallback: best-effort identity from an unparsed body. */
function identityFromRaw(body: unknown): ResultIdentity {
  if (!isRecord(body)) return { requestId: '', correlationId: '' };
  const requestId = body['requestId'];
  const correlationId = body['correlationId'];
  return {
    requestId: typeof requestId === 'string' ? requestId : '',
    correlationId: typeof correlationId === 'string' ? correlationId : '',
  };
}

// R: sortKeysDeep — recursively sort object keys; arrays keep order.
function sortKeysDeep(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    sorted[key] = isRecord(value) ? sortKeysDeep(value) : value;
  }
  return sorted;
}

// R: computeRequestFingerprint — SHA-256 over key-sorted
// {consumerId, ownerId, toolName, payload}; requestId/correlationId/timestamps
// and the deadline are excluded.
function computeRequestFingerprint(input: {
  consumerId: string;
  ownerId: string;
  toolName: string;
  payload: unknown;
}): string {
  const normalized = {
    consumerId: input.consumerId,
    ownerId: input.ownerId,
    toolName: input.toolName,
    payload: input.payload ?? null,
  };
  const json = JSON.stringify(normalized, (_key, value: unknown) => (isRecord(value) ? sortKeysDeep(value) : value));
  return createHash('sha256').update(json, 'utf-8').digest('hex');
}

export function createIdempotentBoundaryCore(options: FakeBoundaryOptions = {}): IdempotentBoundaryCore {
  const now = options.now ?? Date.now;
  const rows: StoredInvocation[] = [];
  const executionCounts = new Map<string, number>();
  let pendingHold: Promise<void> | undefined;
  let pendingFailure: FakeExecutionFailure | undefined;
  let stallNext = false;
  const inProgressWaiters: Array<() => void> = [];

  // D: isDeadlineExpired — unparseable or at/past now is expired (fail-closed).
  function isDeadlineExpired(deadlineAt: string): boolean {
    const deadlineMs = Date.parse(deadlineAt);
    return Number.isNaN(deadlineMs) || deadlineMs <= now();
  }

  // R: the unique index uq_boundary_invocations_key is the four-tuple.
  function findByKey(invocation: ExternalBackendToolInvocationV1): StoredInvocation | undefined {
    return rows.find(
      (row) =>
        row.consumerId === invocation.caller.consumerId &&
        row.ownerId === invocation.subject.ownerId &&
        row.toolName === invocation.toolName &&
        row.idempotencyKey === invocation.idempotencyKey,
    );
  }

  // D executeAndMap: the tool runs and its outcome — success or failure, retryable
  // or not — becomes the mapped terminal result.
  async function execute(toolName: string, identity: ResultIdentity): Promise<ExternalBackendToolResultV1> {
    const hold = pendingHold;
    pendingHold = undefined;
    if (hold) await hold;
    const count = (executionCounts.get(toolName) ?? 0) + 1;
    executionCounts.set(toolName, count);
    const failure = pendingFailure;
    pendingFailure = undefined;
    if (failure) {
      return failureResult(identity, failure.code, failure.message ?? `${toolName} failed`, failure.retryable);
    }
    return successResult(identity, { executionId: `${toolName}-${count}` });
  }

  async function invoke(rawBody: unknown): Promise<CoreInvokeOutcome> {
    // D step 1: envelope validation.
    if (!isInvocationEnvelope(rawBody)) {
      return {
        response: failureResult(identityFromRaw(rawBody), 'validation.invalid_payload', 'malformed invocation envelope', false),
        executed: false,
      };
    }
    const invocation = rawBody;
    const identity: ResultIdentity = { requestId: invocation.requestId, correlationId: invocation.correlationId };

    // D step 1b (and the step-7 re-check, which runs before the store too): the
    // deadline is checked BEFORE the idempotency lookup, so an expired same-key
    // re-issue gets deadline.expired, never the stored result.
    if (isDeadlineExpired(invocation.deadlineAt)) {
      return { response: failureResult(identity, 'deadline.expired', 'request deadline has passed', false), executed: false };
    }

    // D dispatchSideEffecting → R beginOrResolve. Synchronous from lookup to
    // insert, which stands in for the per-key advisory lock (R: BOUNDARY_LOCK_CLASS).
    const requestFingerprint = computeRequestFingerprint({
      consumerId: invocation.caller.consumerId,
      ownerId: invocation.subject.ownerId,
      toolName: invocation.toolName,
      payload: invocation.payload,
    });
    const existing = findByKey(invocation);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        // R conflict → D: same key, different request.
        return {
          response: failureResult(identity, 'validation.invalid_payload', 'idempotency key reused with a different request', false),
          executed: false,
        };
      }
      if (existing.state === 'terminal' && existing.terminalResponse) {
        // R replay → D: the stored result verbatim (original requestId/correlationId).
        return { response: existing.terminalResponse, executed: false };
      }
      // R in_progress → D: status built from the RE-ISSUE's identity; no second run.
      for (const resolve of inProgressWaiters.splice(0)) resolve();
      return { response: inProgressStatus(identity), executed: false };
    }

    // R started: insert in_progress, then the caller owns the single execution.
    const row: StoredInvocation = {
      consumerId: invocation.caller.consumerId,
      ownerId: invocation.subject.ownerId,
      toolName: invocation.toolName,
      idempotencyKey: invocation.idempotencyKey,
      requestFingerprint,
      requestId: invocation.requestId,
      correlationId: invocation.correlationId,
      state: 'in_progress',
      terminalResponse: null,
    };
    rows.push(row);

    const mapped = await execute(invocation.toolName, identity);
    if (stallNext) {
      // D swallows a failed R complete: the caller still gets `mapped`, but the
      // row stays in_progress and every later lookup reports in_progress.
      stallNext = false;
      return { response: mapped, executed: true };
    }
    // R complete: in_progress → terminal with the mapped result stored.
    row.state = 'terminal';
    row.terminalResponse = mapped;
    return { response: mapped, executed: true };
  }

  // D status: R findByRequestId (first row, NOT owner/consumer scoped); never executes.
  function status(requestId: string): FakeInvokeResponse {
    const row = rows.find((candidate) => candidate.requestId === requestId);
    if (!row) {
      return failureResult({ requestId, correlationId: '' }, 'not_found.resource', `no invocation for requestId: ${requestId}`, false);
    }
    const identity: ResultIdentity = { requestId: row.requestId, correlationId: row.correlationId };
    if (row.state !== 'terminal' || !row.terminalResponse) {
      return inProgressStatus(identity);
    }
    return terminalStatus(identity, row.terminalResponse);
  }

  return {
    invoke,
    status,
    executions: (toolName) => executionCounts.get(toolName) ?? 0,
    holdNextExecution() {
      let resolveHold: () => void = () => {};
      const hold = new Promise<void>((resolve) => {
        resolveHold = resolve;
      });
      pendingHold = hold;
      return () => {
        // An unconsumed hold is cancelled so it can never stall a later write.
        if (pendingHold === hold) pendingHold = undefined;
        resolveHold();
      };
    },
    nextInProgressAnswer: () => new Promise<void>((resolve) => inProgressWaiters.push(resolve)),
    failNextExecution(failure) {
      pendingFailure = failure;
    },
    stallNextCompletion() {
      stallNext = true;
    },
  };
}

// ── REST face ──────────────────────────────────────────────────────────────

// A: INVOKE_PATH / STATUS_PATH. Literal here (not the client's constants) so a
// client-side path change is caught rather than mirrored.
const INVOKE_PATH = '/internal/v1/tools:invoke';
const STATUS_PATH_PREFIX = '/internal/v1/invocations/';

/** The transport-neutral controls every face exposes to the contract suite. */
export interface FakeBoundaryControls {
  executions(toolName: string): number;
  /** The next invoke that executes a tool completes it, then drops the connection unanswered. */
  loseNextResponseAfterExecution(): void;
  holdNextExecution(): () => void;
  nextInProgressAnswer(): Promise<void>;
  failNextExecution(failure: FakeExecutionFailure): void;
  stallNextCompletion(): void;
}

export interface FakeIdempotentBoundary extends FakeBoundaryControls {
  /** Base URL of the REST face, e.g. `http://127.0.0.1:54321`. */
  readonly url: string;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // A client that timed out has already gone; there is nobody left to answer.
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startFakeIdempotentBoundary(options: FakeBoundaryOptions = {}): Promise<FakeIdempotentBoundary> {
  const core = createIdempotentBoundaryCore(options);
  let loseNextResponse = false;

  async function handleInvoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : undefined;
    } catch {
      // A step 2: unparseable JSON is a typed 200 failure, not an HTTP error.
      sendJson(res, 200, failureResult({ requestId: '', correlationId: '' }, 'validation.invalid_payload', 'request body is not valid JSON', false));
      return;
    }
    const outcome = await core.invoke(parsed);
    if (outcome.executed && loseNextResponse) {
      loseNextResponse = false;
      // Executed and completed; the response never reaches the client.
      req.socket.destroy();
      return;
    }
    // A: every boundary outcome is HTTP 200 with a typed envelope.
    sendJson(res, 200, outcome.response);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A toSignedRequest: the path is matched with the query string stripped.
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'POST' && path === INVOKE_PATH) {
      await handleInvoke(req, res);
      return;
    }
    if (req.method === 'GET' && path.startsWith(STATUS_PATH_PREFIX)) {
      sendJson(res, 200, core.status(decodeURIComponent(path.slice(STATUS_PATH_PREFIX.length))));
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    // A fake-internal fault surfaces as a 500 (the client maps it to transport_error).
    route(req, res).catch((err: unknown) => sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake boundary did not bind a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    executions: core.executions,
    loseNextResponseAfterExecution() {
      loseNextResponse = true;
    },
    holdNextExecution: core.holdNextExecution,
    nextInProgressAnswer: core.nextInProgressAnswer,
    failNextExecution: core.failNextExecution,
    stallNextCompletion: core.stallNextCompletion,
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

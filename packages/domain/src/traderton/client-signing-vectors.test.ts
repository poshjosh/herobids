import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { TradertonClient } from './client.js';
import {
  TRADERTON_STATUS_PATH_PREFIX,
  tradertonStatusPath,
  type TradertonActorType,
  type TradertonSubject,
  type TradertonToolInvocationStatusV1,
  type TradertonToolResultV1,
} from './contract.js';

/**
 * The client's wire bytes (body + headers) must equal the shared signing vectors
 * (Phase 3 SEAM.md §3.1). Guards envelope construction (T0.6/T1.2) on top of
 * `./signing-vectors.test.ts`, which guards the signer alone.
 */

const FIXTURE_URL = new URL('./__fixtures__/invocation-signing-vectors.json', import.meta.url);
const BASE_URL = 'http://boundary.signing-vector.test';
const ACTOR_TYPES: readonly TradertonActorType[] = ['agent', 'bot', 'user', 'system'];

interface VectorCase {
  id: string;
  method: string;
  requestPath: string;
  signedPath: string;
  timestamp: string;
  deadlineAt: string;
  consumerId: string;
  keyId: string;
  secret: string;
  body: string;
  expectedHeaders: Record<string, string>;
}

/** The envelope fields the client takes as inputs, read back from a recorded body. */
interface RecordedInvokeFields {
  requestId: string;
  idempotencyKey: string;
  correlationId: string;
  issuedAt: string;
  deadlineAt: string;
  subject: TradertonSubject;
  toolName: string;
  payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isActorType(value: unknown): value is TradertonActorType {
  return ACTOR_TYPES.some((type) => type === value);
}

function isVectorCase(value: unknown): value is VectorCase {
  if (!isRecord(value)) return false;
  const stringKeys = [
    'id', 'method', 'requestPath', 'signedPath', 'timestamp', 'deadlineAt', 'consumerId', 'keyId', 'secret', 'body',
  ];
  const headers = value['expectedHeaders'];
  return (
    stringKeys.every((key) => isString(value[key])) &&
    isRecord(headers) &&
    Object.values(headers).every(isString)
  );
}

function isSubject(value: unknown): value is TradertonSubject {
  if (!isRecord(value) || !isString(value['ownerId'])) return false;
  const actor = value['actor'];
  return isRecord(actor) && isActorType(actor['type']) && isString(actor['id']);
}

/**
 * Narrows without rebuilding: the client passes `subject` and `payload` through
 * by reference, so their original key order must survive to reproduce the bytes.
 */
function isRecordedInvokeFields(value: unknown): value is RecordedInvokeFields {
  if (!isRecord(value)) return false;
  const stringKeys = ['requestId', 'idempotencyKey', 'correlationId', 'issuedAt', 'deadlineAt', 'toolName'];
  return stringKeys.every((key) => isString(value[key])) && isSubject(value['subject']) && 'payload' in value;
}

function loadCases(): VectorCase[] {
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed['cases'])) throw new Error('malformed signing-vector fixture');
  const all: unknown[] = parsed['cases'];
  return all.map((c) => {
    if (!isVectorCase(c)) throw new Error('malformed signing-vector case');
    return c;
  });
}

const cases = loadCases();
const postCases = cases.filter((c) => c.method === 'POST');

function caseById(id: string): VectorCase {
  const found = cases.find((c) => c.id === id);
  if (!found) throw new Error(`fixture is missing case ${id}`);
  return found;
}

function clientFor(c: VectorCase): TradertonClient {
  return new TradertonClient({
    baseUrl: BASE_URL,
    consumerId: c.consumerId,
    keyId: c.keyId,
    hmacSecret: c.secret,
    requestTimeoutMs: 10_000,
  });
}

function jsonResponse(body: TradertonToolResultV1 | TradertonToolInvocationStatusV1): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function terminalResult(requestId: string): TradertonToolResultV1 {
  return { contractVersion: '1.0', requestId, correlationId: requestId, outcome: { kind: 'success', payload: {} } };
}

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  // Only Date is faked: the client stamps X-Traderton-Timestamp from `new Date()`.
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('client wire bytes match the invocation signing vectors', () => {
  it.each(postCases)('invoke sends the recorded body and headers for $id', async (c) => {
    vi.setSystemTime(new Date(c.timestamp));
    const recorded: unknown = JSON.parse(c.body);
    if (!isRecordedInvokeFields(recorded)) throw new Error(`${c.id} body is not an invocation envelope`);
    fetchMock.mockImplementation(async () => jsonResponse(terminalResult(recorded.requestId)));

    const result = await clientFor(c).invoke({
      toolName: recorded.toolName,
      payload: recorded.payload,
      subject: recorded.subject,
      deadlineAt: recorded.deadlineAt,
      requestId: recorded.requestId,
      idempotencyKey: recorded.idempotencyKey,
      correlationId: recorded.correlationId,
      issuedAt: recorded.issuedAt,
    });

    expect(result.kind).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}${c.requestPath}`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(c.body);
    expect(init?.headers).toEqual(c.expectedHeaders);
  });

  it('poll sends the recorded headers for status-empty-body', async () => {
    const c = caseById('status-empty-body');
    vi.setSystemTime(new Date(c.timestamp));
    const requestId = decodeURIComponent(c.signedPath.slice(TRADERTON_STATUS_PATH_PREFIX.length));
    expect(tradertonStatusPath(requestId)).toBe(c.signedPath);
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        contractVersion: '1.0',
        requestId,
        correlationId: requestId,
        state: 'terminal',
        result: terminalResult(requestId),
      }),
    );

    const result = await clientFor(c).poll(requestId, { deadlineAt: c.deadlineAt });

    expect(result.kind).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}${c.signedPath}`);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual(c.expectedHeaders);
  });

  it('status-query-stripped: the client builds the bare signed path and never emits a query', () => {
    const c = caseById('status-query-stripped');
    const requestId = decodeURIComponent(c.signedPath.slice(TRADERTON_STATUS_PATH_PREFIX.length));
    expect(c.requestPath.split('?')[0]).toBe(c.signedPath);
    expect(tradertonStatusPath(requestId)).toBe(c.signedPath);
    expect(tradertonStatusPath(requestId)).not.toContain('?');
  });
});

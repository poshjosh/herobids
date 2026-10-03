import { afterEach, describe, expect, it } from 'vitest';
import {
  createExternalBackendClient,
  type ExternalBackendClient,
  type ExternalBackendFailureCode,
  type ExternalBackendProtocol,
  type ExternalBackendSubject,
} from '@herobids/domain/external-backend';
import {
  FAKE_MCP_PATH,
  startFakeIdempotentBoundary,
  startFakeMcpBoundary,
  type FakeBoundaryControls,
  type FakeIdempotentBoundary,
} from './__tests__/fake-idempotent-boundary.js';

/**
 * Transport parity (Phase 3 T2.3 / G5/G7). The SAME behaviour is proved on REST
 * and MCP against the same idempotency core behind two faces: closed-union
 * codes and the retryable flag survive verbatim, success payloads are
 * unchanged, in_progress resolves, outages fail-closed within the attempt
 * timeout, a same-key re-issue executes once, an auth failure is a terminal
 * non-retryable failure, and the identifiers cross the wire untouched. Every
 * test touches only the generic client + the transport-neutral controls — no
 * transport symbol appears above the seam.
 */

const CONSUMER_ID = 'herobids-parity';
const SUBJECT: ExternalBackendSubject = { ownerId: 'owner-parity', actor: { type: 'agent', id: 'agent-parity' } };

interface ParityBackend {
  backend: FakeIdempotentBoundary & FakeBoundaryControls;
  client(requestTimeoutMs?: number): ExternalBackendClient;
  close(): Promise<void>;
}

function makeClient(baseUrl: string, protocol: ExternalBackendProtocol, requestTimeoutMs: number): ExternalBackendClient {
  return createExternalBackendClient({
    baseUrl,
    consumerId: CONSUMER_ID,
    keyId: 'parity',
    hmacSecret: 'parity-secret',
    requestTimeoutMs,
    protocol,
    ...(protocol === 'mcp' ? { mcpPath: FAKE_MCP_PATH } : {}),
  });
}

const TRANSPORTS: ReadonlyArray<{
  transport: ExternalBackendProtocol;
  start(): Promise<FakeIdempotentBoundary>;
  /** The path a refused-connection client points at (unused port, same protocol). */
  deadPath: string;
}> = [
  { transport: 'rest', start: startFakeIdempotentBoundary, deadPath: '/internal/v1/tools:invoke' },
  { transport: 'mcp', start: startFakeMcpBoundary, deadPath: FAKE_MCP_PATH },
];

const ALL_FAILURE_CODES: Array<{ code: ExternalBackendFailureCode; retryable: boolean }> = [
  { code: 'validation.invalid_payload', retryable: false },
  { code: 'authentication.invalid_caller', retryable: false },
  { code: 'authorization.denied', retryable: false },
  { code: 'not_found.resource', retryable: false },
  { code: 'precondition.not_ready', retryable: false },
  { code: 'rate_limit.exceeded', retryable: true },
  { code: 'deadline.expired', retryable: false },
  { code: 'upstream.transient', retryable: true },
  { code: 'internal.non_retryable', retryable: false },
  { code: 'contract.unsupported_version', retryable: false },
];

describe.each(TRANSPORTS)('transport parity over $transport', ({ transport, start, deadPath }) => {
  let open: ParityBackend | undefined;

  async function openBackend(): Promise<ParityBackend> {
    const backend = await start();
    open = {
      backend,
      client: (requestTimeoutMs = 5_000) => makeClient(backend.url, transport, requestTimeoutMs),
      close: () => backend.close(),
    };
    return open;
  }

  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  function write(idempotencyKey: string, deadlineMs = 5_000) {
    return {
      toolName: 'submit_decision',
      payload: { instrumentId: 'BTC' },
      subject: SUBJECT,
      idempotencyKey,
      deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
    };
  }

  it(`preserves every closed-union failure code and its retryable flag verbatim over ${transport}`, async () => {
    const { backend, client } = await openBackend();
    const c = client();

    for (const { code, retryable } of ALL_FAILURE_CODES) {
      backend.respondNextWith({ kind: 'failure', code, message: `${code} happened`, retryable });
      const result = await c.invoke({ ...write(`code-${code}`), payload: { instrumentId: 'BTC' } });
      expect(result).toMatchObject({ kind: 'failure', code, retryable });
    }
  });

  it(`returns success payloads unchanged over ${transport}`, async () => {
    const { backend, client } = await openBackend();
    backend.respondNextWith({ kind: 'success', payload: { botId: 'bot-7', nested: { ok: true, n: 42 } } });

    const result = await client().invoke(write('success-key'));

    expect(result).toMatchObject({ kind: 'success', payload: { botId: 'bot-7', nested: { ok: true, n: 42 } } });
  });

  it(`reports a running same-key invocation as in_progress and then resolves it over ${transport}`, async () => {
    const { backend, client } = await openBackend();
    // First attempt times out before the held execution finishes; the re-issue
    // then finds the write running and is answered in_progress. invokeAndAwait
    // sequences this deterministically (no race over which frame executes first).
    const release = backend.holdNextExecution();
    const inProgressAnswered = backend.nextInProgressAnswer();

    const pending = client(400).invokeAndAwait({
      toolName: 'submit_decision',
      payload: { instrumentId: 'BTC' },
      subject: SUBJECT,
      idempotencyKey: 'running-key',
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    });
    const tag = await Promise.race([
      inProgressAnswered.then(() => 'in_progress' as const),
      pending.then(() => 'settled' as const),
    ]);
    release();
    const settled = await pending;

    expect(tag).toBe('in_progress');
    expect(settled.kind).toBe('success');
    expect(backend.executions('submit_decision')).toBe(1);
  });

  it(`maps a refused connection to transport_error within the attempt timeout over ${transport}`, async () => {
    await openBackend(); // bind then immediately close so the port refuses.
    await open!.close();
    open = undefined;
    // A port that nothing listens on → connection refused.
    const dead = makeClient('http://127.0.0.1:1', transport, 2_000);

    const started = Date.now();
    const result = await dead.invoke({ toolName: 'submit_decision', payload: { instrumentId: 'BTC' }, subject: SUBJECT, idempotencyKey: 'refused', deadlineAt: new Date(Date.now() + 2_000).toISOString() });
    const elapsed = Date.now() - started;

    expect(result.kind).toBe('transport_error');
    expect(elapsed).toBeLessThan(2_000);
    expect(deadPath).toBeTruthy(); // documents the path a client of this protocol signs
  });

  it(`maps a backend that never answers to transport_error at the attempt timeout without hanging over ${transport}`, async () => {
    const { backend, client } = await openBackend();
    // Hold the execution forever; a short attempt timeout must win.
    backend.holdNextExecution();

    const started = Date.now();
    const result = await client(300).invoke(write('never-answers', 10_000));
    const elapsed = Date.now() - started;

    expect(result.kind).toBe('transport_error');
    expect(elapsed).toBeLessThan(5_000);
  });

  it(`executes once when a same-key re-issue follows an outage and recovery over ${transport}`, async () => {
    const { backend, client } = await openBackend();
    backend.loseNextResponseAfterExecution();

    // invokeAndAwait: first attempt executes but its response is lost; the
    // same-key re-issue replays the stored terminal result — one execution.
    const result = await client().invokeAndAwait({
      toolName: 'submit_decision',
      payload: { instrumentId: 'BTC' },
      subject: SUBJECT,
      idempotencyKey: 'outage-recovery',
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    });

    expect(result.kind).toBe('success');
    expect(backend.executions('submit_decision')).toBe(1);
  });

  it(`maps an authentication failure to terminal authentication.invalid_caller, non-retryable, over ${transport}`, async () => {
    const { backend, client } = await openBackend();
    backend.rejectNextAuthentication();

    const result = await client().invoke(write('auth-fail'));

    expect(result).toMatchObject({ kind: 'failure', code: 'authentication.invalid_caller', retryable: false });
    // No execution happened — auth is rejected before the store.
    expect(backend.executions('submit_decision')).toBe(0);
  });

  it(`carries requestId and idempotencyKey on the wire unchanged over ${transport}`, async () => {
    const { backend, client } = await openBackend();
    const requestId = 'req-parity-fixed';

    await client().invoke({
      toolName: 'submit_decision',
      payload: { instrumentId: 'BTC' },
      subject: SUBJECT,
      idempotencyKey: 'wire-key',
      requestId,
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    });

    const invokeFrame = backend
      .recordedFrames()
      .map((frame) => JSON.parse(frame.rawBody === '' ? '{}' : frame.rawBody) as Record<string, unknown>)
      .find((body) => {
        if (transport === 'rest') return body['toolName'] === 'submit_decision';
        // MCP: the tools/call frame carries the fields in params._meta.
        const params = body['params'];
        return typeof params === 'object' && params !== null && 'name' in params && (params as { name: unknown }).name === 'submit_decision';
      });
    expect(invokeFrame).toBeDefined();

    if (transport === 'rest') {
      expect(invokeFrame).toMatchObject({ requestId, idempotencyKey: 'wire-key' });
    } else {
      const meta = ((invokeFrame as { params: { _meta: Record<string, unknown> } }).params)._meta;
      expect(meta).toMatchObject({ requestId, idempotencyKey: 'wire-key' });
    }
  });
});

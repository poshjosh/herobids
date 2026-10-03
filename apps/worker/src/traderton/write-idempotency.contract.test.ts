import { afterEach, describe, expect, it } from 'vitest';
import {
  createExternalBackendClient,
  deriveRequestId,
  type ExternalBackendClient,
  type ExternalBackendSubject,
} from '@herobids/domain/external-backend';
import { createTradertonSideEffectBoundary, type TradertonSideEffectBoundary } from './write-adapter.js';
import { startFakeIdempotentBoundary, type FakeBoundaryControls } from './__tests__/fake-idempotent-boundary.js';

/**
 * Write-path idempotency contract (Phase 3 T0.6 / G5). Every case drives the
 * real side-effect adapter + client against a fake backend that models the
 * traderton idempotency store, and touches only the generic boundary port plus
 * transport-neutral backend controls — so T2.3 can append an `mcp` harness and
 * run the same cases unchanged (G7).
 */

interface HarnessOptions {
  /** Client per-request timeout; short when a test needs the first attempt to time out. */
  requestTimeoutMs: number;
}

interface WriteContractHarness {
  boundary: TradertonSideEffectBoundary;
  backend: FakeBoundaryControls;
  close(): Promise<void>;
}

const CONSUMER_ID = 'herobids-contract';
const SUBJECT: ExternalBackendSubject = { ownerId: 'owner-contract', actor: { type: 'agent', id: 'agent-contract' } };
const DEFAULT_OPTIONS: HarnessOptions = { requestTimeoutMs: 5_000 };

function restClient(baseUrl: string, options: HarnessOptions): ExternalBackendClient {
  return createExternalBackendClient({
    baseUrl,
    consumerId: CONSUMER_ID,
    keyId: 'contract',
    hmacSecret: 'contract-secret',
    requestTimeoutMs: options.requestTimeoutMs,
  });
}

async function createRestHarness(options: HarnessOptions): Promise<WriteContractHarness> {
  const backend = await startFakeIdempotentBoundary();
  return {
    boundary: createTradertonSideEffectBoundary(restClient(backend.url, options)),
    backend,
    close: () => backend.close(),
  };
}

const WRITE_CONTRACT_TRANSPORTS: ReadonlyArray<{
  transport: 'rest' | 'mcp';
  createHarness: (options: HarnessOptions) => Promise<WriteContractHarness>;
}> = [{ transport: 'rest', createHarness: createRestHarness }]; // T2.3 appends { transport: 'mcp', ... }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBotWrite(idempotencyKey: string, deadlineMs = 5_000) {
  return {
    toolName: 'create_bot',
    payload: { venueAccountId: 'va-1', config: { symbol: 'BTC-USD', strategy: { type: 'momentum' } } },
    subject: SUBJECT,
    deadlineMs,
    idempotencyKey,
  };
}

describe.each(WRITE_CONTRACT_TRANSPORTS)('write-path idempotency contract over $transport', ({ createHarness }) => {
  let harness: WriteContractHarness | undefined;

  async function openHarness(options: HarnessOptions = DEFAULT_OPTIONS): Promise<WriteContractHarness> {
    harness = await createHarness(options);
    return harness;
  }

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('sending the same idempotency key twice executes the write once and replays the first result', async () => {
    const { boundary, backend } = await openHarness();

    const first = await boundary.invokeAndAwait(createBotWrite('key-same'));
    const second = await boundary.invokeAndAwait(createBotWrite('key-same'));

    expect(first.kind).toBe('success');
    expect(second).toEqual(first);
    expect(backend.executions('create_bot')).toBe(1);
  });

  it('reusing the idempotency key with a changed payload returns validation.invalid_payload without a second execution', async () => {
    const { boundary, backend } = await openHarness();

    await boundary.invokeAndAwait(createBotWrite('key-changed'));
    const changed = await boundary.invokeAndAwait({
      ...createBotWrite('key-changed'),
      payload: { venueAccountId: 'va-1', config: { symbol: 'ETH-USD', strategy: { type: 'momentum' } } },
    });

    expect(changed).toMatchObject({ kind: 'failure', code: 'validation.invalid_payload', retryable: false });
    expect(backend.executions('create_bot')).toBe(1);
  });

  it('a response lost after execution is recovered by the same-key re-issue without a second execution', async () => {
    const { boundary, backend } = await openHarness();
    backend.loseNextResponseAfterExecution();

    const result = await boundary.invokeAndAwait(createBotWrite('key-lost'));

    expect(result.kind).toBe('success');
    expect(backend.executions('create_bot')).toBe(1);
  });

  it('a write still running when the response is lost resolves to its terminal result without a second execution', async () => {
    // The first attempt outlives the client timeout; the re-issue finds it running.
    const { boundary, backend } = await openHarness({ requestTimeoutMs: 500 });
    const release = backend.holdNextExecution();
    const inProgressAnswered = backend.nextInProgressAnswer();

    const pending = boundary.invokeAndAwait(createBotWrite('key-running', 10_000));
    // Release once the re-issue is answered in_progress (or the call gave up).
    const tag = await Promise.race([
      inProgressAnswered.then(() => 'in_progress' as const),
      pending.then(() => 'settled' as const),
    ]);
    release();
    const result = await pending;

    expect(tag).toBe('in_progress');
    expect(result.kind).toBe('success');
    expect(backend.executions('create_bot')).toBe(1);
  });

  it('a later follow-up with the persisted key recovers the terminal result', async () => {
    const { boundary, backend } = await openHarness();
    const deadlineMs = 400;
    const release = backend.holdNextExecution();
    backend.loseNextResponseAfterExecution();

    // The first call executes, but its response is lost after its deadline, so
    // there is no budget left to reconcile in-call: the outcome stays unknown.
    const pending = boundary.invokeAndAwait(createBotWrite('key-follow-up', deadlineMs));
    await sleep(deadlineMs + 200);
    // Releasing also cancels an unconsumed hold, so the follow-up never waits on it.
    release();
    const first = await pending;
    expect(first.kind).toBe('transport_error');
    expect(backend.executions('create_bot')).toBe(1);

    const followUp = await boundary.invokeAndAwait(createBotWrite('key-follow-up'));

    expect(followUp.kind).toBe('success');
    expect(backend.executions('create_bot')).toBe(1);
  });

  it('a write still running at the deadline is an unknown outcome, and a same-key follow-up replays it once complete', async () => {
    const { boundary, backend } = await openHarness({ requestTimeoutMs: 300 });
    const release = backend.holdNextExecution();

    // First attempt times out at 300ms; the re-issue sees in_progress; the poll
    // reaches the deadline while the held execution is still running.
    const atDeadline = await boundary.invokeAndAwait(createBotWrite('key-deadline', 1_000)).finally(release);
    expect(atDeadline.kind).toBe('in_progress');

    const followUp = await boundary.invokeAndAwait(createBotWrite('key-deadline'));

    expect(followUp.kind).toBe('success');
    expect(backend.executions('create_bot')).toBe(1);
  });

  it('a stored terminal failure is replayed for the same key without a second execution, even when retryable', async () => {
    const { boundary, backend } = await openHarness();
    backend.failNextExecution({ code: 'upstream.transient', retryable: true, message: 'venue busy' });

    const first = await boundary.invokeAndAwait(createBotWrite('key-failed'));
    const second = await boundary.invokeAndAwait(createBotWrite('key-failed'));

    expect(first).toMatchObject({ kind: 'failure', code: 'upstream.transient', retryable: true });
    expect(second).toEqual(first);
    expect(backend.executions('create_bot')).toBe(1);
  });

  it('a write whose completion was never recorded stays an unknown outcome rather than a rejection', async () => {
    const { boundary, backend } = await openHarness();
    backend.stallNextCompletion();
    backend.loseNextResponseAfterExecution();

    // Executed, response lost, and the row never reaches terminal: the re-issue
    // and every status poll report in_progress until the deadline.
    const result = await boundary.invokeAndAwait(createBotWrite('key-stalled', 500));

    expect(result.kind).toBe('in_progress');
    expect(backend.executions('create_bot')).toBe(1);
  });
});

// The status endpoint has no MCP equivalent (D15), so this block stays REST-only.
describe('write-path idempotency contract — REST status endpoint', () => {
  it('the status endpoint returns the terminal result for the requestId recomputed from the persisted key', async () => {
    const backend = await startFakeIdempotentBoundary();
    try {
      const client = restClient(backend.url, DEFAULT_OPTIONS);
      const boundary = createTradertonSideEffectBoundary(client);
      backend.loseNextResponseAfterExecution();

      // A single attempt whose response is lost (e.g. the worker crashed after sending).
      const lost = await boundary.invoke({ toolName: 'submit_decision', payload: { instrumentId: 'BTC' }, subject: SUBJECT, idempotencyKey: 'dec-status' });
      expect(lost.kind).toBe('transport_error');

      const requestId = deriveRequestId({
        consumerId: CONSUMER_ID,
        ownerId: SUBJECT.ownerId,
        toolName: 'submit_decision',
        idempotencyKey: 'dec-status',
      });
      expect(lost.requestId).toBe(requestId);
      const status = await client.poll(requestId, { deadlineAt: new Date(Date.now() + 5_000).toISOString(), pollIntervalMs: 10 });

      expect(status.kind).toBe('success');
      expect(backend.executions('submit_decision')).toBe(1);
    } finally {
      await backend.close();
    }
  });

  it('the status endpoint reports not_found.resource for a requestId the backend never stored', async () => {
    const backend = await startFakeIdempotentBoundary();
    try {
      const client = restClient(backend.url, DEFAULT_OPTIONS);
      const requestId = deriveRequestId({
        consumerId: CONSUMER_ID,
        ownerId: SUBJECT.ownerId,
        toolName: 'submit_decision',
        idempotencyKey: 'never-sent',
      });

      const status = await client.poll(requestId, { deadlineAt: new Date(Date.now() + 5_000).toISOString(), pollIntervalMs: 10 });

      expect(status).toMatchObject({ kind: 'failure', code: 'not_found.resource' });
    } finally {
      await backend.close();
    }
  });
});

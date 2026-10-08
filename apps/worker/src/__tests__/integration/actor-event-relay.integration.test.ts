/**
 * End-to-end integration (E3-H Part C): a traderton outbox agent_wake row flows
 * through the relay onto the agent's Redis stream, and the runtime parsing path
 * reconstructs it as a scanner wake that unblocks the hybrid tick.
 *
 * Real legs: ActorEventRelay → real Redis (XADD) → real InstanceEventPublisher
 * envelope → runtime parsing (bufferWakeEnvelope / drainNewestWakeIntoMarketWake
 * / applyRuntimeMessage / buildTickGateState).
 * Stubbed leg: the traderton consumer_notifications outbox (a fake
 * ConsumerNotificationFeed). A full cross-stack CI leg (real traderton scan →
 * outbox → relay) is recorded as a follow-up in the plan.
 *
 * Requires REDIS_URL. Skipped otherwise. Uses a throwaway/dev Redis — never the
 * traderton Redis.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import crypto from 'node:crypto';
import { ActorEventRelay } from '../../agents/actor-event-relay.js';
import { InstanceEventPublisher } from '../../agents/instance-event-publisher.js';
import type { ConsumerNotificationFeed, ConsumerNotificationRow } from '../../agents/boundary-consumer-notification-feed.js';
import { bufferWakeEnvelope, drainNewestWakeIntoMarketWake, applyRuntimeMessage, createRuntimeCompositionState } from '../../runtime-composition.js';
import { buildTickGateState } from '../../tick-gate-state.js';
import type { ActorEventRelayConfig } from '@herobids/domain';

const SKIP = !process.env['REDIS_URL'];
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || 'localhost',
    port: parseInt(parsed.port || '6379', 10),
    ...(parsed.password && { password: decodeURIComponent(parsed.password) }),
    ...(parsed.username && { username: decodeURIComponent(parsed.username) }),
  };
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as import('pino').Logger;
}

const config: ActorEventRelayConfig = {
  enabled: true,
  pollIntervalMs: 5000,
  maxBatchSize: 100,
  maxEventAgeMs: 600_000,
  settleLagMs: 5000,
};

describe.skipIf(SKIP)('Worker: actor-event relay end-to-end', () => {
  const redis = new Redis(parseRedisUrl(REDIS_URL));
  const agentId = crypto.randomUUID();
  const streamKey = `agent:outbound:${agentId}`;

  // The relay's lease and cursor keys (lease:actor-event-relay,
  // actor-event-relay:cursor) are global, not namespaced per test run. If a
  // previous run of this suite was interrupted before its afterAll ran (CI
  // kill, crash, timeout), the lease can outlive that run for up to its 30s
  // TTL and make this run's tick() a silent no-op via holdLease() — the
  // relay behaves correctly (refusing to double-process while another
  // worker holds the lease) but the test would then see zero stream entries
  // for a reason unrelated to the behaviour under test. Clear both before
  // the test starts, not just after, so stale state from an interrupted
  // prior run can never poison this run.
  beforeAll(async () => {
    await redis.del('actor-event-relay:cursor').catch(() => { /* ignore */ });
    await redis.del('lease:actor-event-relay').catch(() => { /* ignore */ });
  });

  afterAll(async () => {
    await redis.del(streamKey).catch(() => { /* ignore */ });
    await redis.del('actor-event-relay:cursor').catch(() => { /* ignore */ });
    await redis.del('lease:actor-event-relay').catch(() => { /* ignore */ });
    redis.disconnect();
  });

  it('relays a scanner agent_wake onto the agent stream and the runtime reconstructs it as a scanner wake', async () => {
    const now = Date.now();
    const wake = {
      wakeId: 'wake-e2e-1',
      source: 'scanner' as const,
      reason: '2 ranked scanner signals ready',
      eventIds: ['evt-1'],
      priority: 'normal' as const,
      requestedAt: new Date(now).toISOString(),
      context: { scannerKind: 'signal_scoring' as const, signalCount: 2, topSymbol: 'BTC', topConfidence: 0.9, regimePass: true },
    };
    const scanRow: ConsumerNotificationRow = {
      id: crypto.randomUUID(),
      type: 'agent_wake',
      ownerId: crypto.randomUUID(),
      agentId,
      botId: null,
      payload: { wake },
      createdAt: new Date(now - 60_000), // older than the settle lag
    };

    let scanned = 0;
    const feed: ConsumerNotificationFeed = {
      // First scan returns the row; later scans return nothing (the cursor
      // persisted past it). We DON'T apply the cursor filter here — the second
      // tick's empty return models the persisted-cursor outcome.
      scan: async () => (scanned++ === 0 ? [scanRow] : []),
    };

    const relay = new ActorEventRelay({
      config,
      feed,
      eventPublisher: new InstanceEventPublisher(redis),
      // Not exercised by an agent_wake row:
      userEventPublisher: { publishBotStatusStrict: async () => undefined } as never,
      sessionManager: { handleRuntimeFailure: async () => undefined } as never,
      agentRepo: { getActiveSession: async () => null } as never,
      redis,
      workerId: `worker-${crypto.randomUUID().slice(0, 8)}`,
      logger: silentLogger(),
      now: () => now,
    });

    // (2) one tick republishes the row onto the real stream.
    await relay.tick();

    // (3) the stream holds an agent.wake envelope with the wake under payload.
    const entries = await redis.xrange(streamKey, '-', '+');
    expect(entries.length).toBe(1);
    const [, fields] = entries[0]!;
    const envelopeJson = fields[fields.indexOf('envelope') + 1]!;
    const envelope = JSON.parse(envelopeJson) as Record<string, unknown>;
    expect(envelope['type']).toBe('agent.wake');
    expect((envelope['payload'] as { source?: string }).source).toBe('scanner');
    expect((envelope['payload'] as { wakeId?: string }).wakeId).toBe('wake-e2e-1');

    // (4) runtime parsing reconstructs the scanner wake.
    const buffered = bufferWakeEnvelope(envelope, now)!;
    expect(buffered.source).toBe('scanner');
    const { wake: drained } = drainNewestWakeIntoMarketWake([buffered], null);
    expect(drained?.source).toBe('scanner');

    const state = createRuntimeCompositionState({ agentId } as never);
    applyRuntimeMessage(state, envelope);
    expect(state.metrics.currentMarketWake?.source).toBe('scanner');

    const gate = buildTickGateState({ tickNumber: 1, incomingMessages: [envelope], hasOpenPositions: false });
    expect(gate.hasWakeSignal).toBe(true);

    // (5) a second tick publishes nothing (the cursor persisted past the row).
    await relay.tick();
    const after = await redis.xrange(streamKey, '-', '+');
    expect(after.length).toBe(1);
  });
});

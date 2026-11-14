import { describe, expect, it } from 'vitest';
import type { ServerHealthSnapshot } from '../../lib/api-client.js';
import {
  isBrowserNodeSaturated,
  readBrowserPoolMetrics,
  sessionUtilizationPct,
  summarizeBrowserPool,
} from './browser-pool-metrics.js';

function snapshot(metadata: Record<string, unknown>): ServerHealthSnapshot {
  return {
    serverType: 'browser-pool',
    serverId: 'bp-1',
    hostname: 'bp-1',
    memory: { totalBytes: 100, usedBytes: 0, freeBytes: 100 },
    disk: null,
    cpuPct: 0,
    loadAvg: [0, 0, 0],
    uptimeSeconds: 0,
    version: '0.0.0',
    updatedAt: '2026-11-14T00:00:00.000Z',
    metadata,
  };
}

describe('readBrowserPoolMetrics', () => {
  it('reads all fields when present and correctly typed', () => {
    const metrics = readBrowserPoolMetrics({
      activeSessions: 3,
      maxConcurrentSessions: 10,
      queuedRequests: 2,
      recentlyRejected: 1,
      isAvailable: true,
      memoryPressure: 42,
    });
    expect(metrics).toEqual({
      activeSessions: 3,
      maxConcurrentSessions: 10,
      queuedRequests: 2,
      recentlyRejected: 1,
      isAvailable: true,
      memoryPressure: 42,
    });
  });

  it('returns null for missing fields without throwing', () => {
    expect(readBrowserPoolMetrics({})).toEqual({
      activeSessions: null,
      maxConcurrentSessions: null,
      queuedRequests: null,
      recentlyRejected: null,
      isAvailable: null,
      memoryPressure: null,
    });
  });

  it('returns null for wrong-typed values', () => {
    const metrics = readBrowserPoolMetrics({
      activeSessions: '3',
      maxConcurrentSessions: Number.NaN,
      isAvailable: 'yes',
      queuedRequests: null,
    });
    expect(metrics.activeSessions).toBeNull();
    expect(metrics.maxConcurrentSessions).toBeNull();
    expect(metrics.isAvailable).toBeNull();
    expect(metrics.queuedRequests).toBeNull();
  });
});

describe('sessionUtilizationPct', () => {
  it('computes the percentage of capacity in use', () => {
    expect(sessionUtilizationPct(readBrowserPoolMetrics({ activeSessions: 3, maxConcurrentSessions: 10 }))).toBe(30);
  });

  it('returns null when capacity is unknown or zero', () => {
    expect(sessionUtilizationPct(readBrowserPoolMetrics({ activeSessions: 3 }))).toBeNull();
    expect(sessionUtilizationPct(readBrowserPoolMetrics({ activeSessions: 3, maxConcurrentSessions: 0 }))).toBeNull();
  });
});

describe('isBrowserNodeSaturated', () => {
  it('flags a node reporting it is unavailable', () => {
    expect(isBrowserNodeSaturated(readBrowserPoolMetrics({ isAvailable: false, activeSessions: 0, maxConcurrentSessions: 10 }))).toBe(true);
  });

  it('flags a node at or over the saturation line', () => {
    expect(isBrowserNodeSaturated(readBrowserPoolMetrics({ activeSessions: 9, maxConcurrentSessions: 10 }))).toBe(true);
  });

  it('does not flag an available node below the saturation line, even with queued requests', () => {
    expect(isBrowserNodeSaturated(readBrowserPoolMetrics({ activeSessions: 1, maxConcurrentSessions: 10, isAvailable: true, queuedRequests: 5 }))).toBe(false);
  });

  it('does not flag when capacity is unknown', () => {
    expect(isBrowserNodeSaturated(readBrowserPoolMetrics({ activeSessions: 100 }))).toBe(false);
  });
});

describe('summarizeBrowserPool', () => {
  it('sums session fields across instances, ignoring nulls', () => {
    const summary = summarizeBrowserPool([
      snapshot({ activeSessions: 3, maxConcurrentSessions: 10, queuedRequests: 1, recentlyRejected: 2, isAvailable: true }),
      snapshot({ activeSessions: 5, maxConcurrentSessions: 10, recentlyRejected: 1, isAvailable: true }),
    ]);
    expect(summary.totalActiveSessions).toBe(8);
    expect(summary.totalMaxSessions).toBe(20);
    expect(summary.totalQueued).toBe(1);
    expect(summary.totalRejected).toBe(3);
    expect(summary.utilizationPct).toBe(40);
  });

  it('counts available instances', () => {
    const summary = summarizeBrowserPool([
      snapshot({ isAvailable: true }),
      snapshot({ isAvailable: false }),
      snapshot({ isAvailable: true }),
    ]);
    expect(summary.instanceCount).toBe(3);
    expect(summary.availableCount).toBe(2);
  });

  it('omits utilization when no instance reports a capacity', () => {
    const summary = summarizeBrowserPool([snapshot({ activeSessions: 3 }), snapshot({ activeSessions: 2 })]);
    expect(summary.totalActiveSessions).toBe(5);
    expect(summary.totalMaxSessions).toBe(0);
    expect(summary.utilizationPct).toBeNull();
  });

  it('returns a zeroed summary for empty input, never NaN', () => {
    const summary = summarizeBrowserPool([]);
    expect(summary).toEqual({
      instanceCount: 0,
      availableCount: 0,
      totalActiveSessions: 0,
      totalMaxSessions: 0,
      totalQueued: 0,
      totalRejected: 0,
      utilizationPct: null,
    });
  });
});

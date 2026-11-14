import type { ServerHealthSnapshot } from '../../lib/api-client.js';
import { USAGE_DANGER_PCT } from './capacity-display.js';

/**
 * Browser-pool session metrics read from a health snapshot's untyped `metadata`.
 * Every field is nullable: a stale or partial snapshot may omit any of them, and a
 * wrong-typed value is treated as absent rather than trusted.
 */
export interface BrowserPoolMetrics {
  activeSessions: number | null;
  maxConcurrentSessions: number | null;
  queuedRequests: number | null;
  recentlyRejected: number | null;
  isAvailable: boolean | null;
  memoryPressure: number | null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Narrow a browser-pool snapshot's `metadata` into a typed, guarded shape. Never throws. */
export function readBrowserPoolMetrics(metadata: Record<string, unknown>): BrowserPoolMetrics {
  return {
    activeSessions: readNumber(metadata['activeSessions']),
    maxConcurrentSessions: readNumber(metadata['maxConcurrentSessions']),
    queuedRequests: readNumber(metadata['queuedRequests']),
    recentlyRejected: readNumber(metadata['recentlyRejected']),
    isAvailable: readBoolean(metadata['isAvailable']),
    memoryPressure: readNumber(metadata['memoryPressure']),
  };
}

/** Session utilization percent (0-100), or null when capacity is unknown or zero. */
export function sessionUtilizationPct(metrics: BrowserPoolMetrics): number | null {
  const { activeSessions, maxConcurrentSessions } = metrics;
  if (activeSessions === null || maxConcurrentSessions === null || maxConcurrentSessions <= 0) {
    return null;
  }
  return Math.round((activeSessions / maxConcurrentSessions) * 100);
}

/** Utilization at or above this percent marks a node as saturated. Shares the UsageBar danger line. */
export const SATURATION_PCT = USAGE_DANGER_PCT;

/**
 * A node is flagged when it cannot take work (explicitly unavailable) or is effectively
 * full (session utilization at or over the saturation line). Queue depth alone is not a
 * flag: transient queueing on an otherwise-healthy node should not raise a false alarm.
 */
export function isBrowserNodeSaturated(metrics: BrowserPoolMetrics): boolean {
  if (metrics.isAvailable === false) return true;
  const pct = sessionUtilizationPct(metrics);
  return pct !== null && pct >= SATURATION_PCT;
}

/** Pool-wide totals across the reporting browser-pool instances. */
export interface BrowserPoolSummary {
  /** Instances in the group (whether or not they reported sessions). */
  instanceCount: number;
  /** Instances reporting `isAvailable: true`. */
  availableCount: number;
  totalActiveSessions: number;
  totalMaxSessions: number;
  totalQueued: number;
  totalRejected: number;
  /** Pool utilization percent, or null when no instance reports a capacity. */
  utilizationPct: number | null;
}

/** Aggregate session pressure across a group of browser-pool snapshots. Ignores absent fields. */
export function summarizeBrowserPool(servers: ServerHealthSnapshot[]): BrowserPoolSummary {
  let availableCount = 0;
  let totalActiveSessions = 0;
  let totalMaxSessions = 0;
  let totalQueued = 0;
  let totalRejected = 0;
  let anyCapacityReported = false;

  for (const server of servers) {
    const metrics = readBrowserPoolMetrics(server.metadata);
    if (metrics.isAvailable === true) availableCount += 1;
    if (metrics.activeSessions !== null) totalActiveSessions += metrics.activeSessions;
    if (metrics.maxConcurrentSessions !== null) {
      totalMaxSessions += metrics.maxConcurrentSessions;
      anyCapacityReported = true;
    }
    if (metrics.queuedRequests !== null) totalQueued += metrics.queuedRequests;
    if (metrics.recentlyRejected !== null) totalRejected += metrics.recentlyRejected;
  }

  const utilizationPct = anyCapacityReported && totalMaxSessions > 0
    ? Math.round((totalActiveSessions / totalMaxSessions) * 100)
    : null;

  return {
    instanceCount: servers.length,
    availableCount,
    totalActiveSessions,
    totalMaxSessions,
    totalQueued,
    totalRejected,
    utilizationPct,
  };
}

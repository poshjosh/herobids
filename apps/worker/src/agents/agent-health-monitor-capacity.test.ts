import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RUNTIME_ERROR_CODES } from '@herobids/domain';
import { AgentHealthMonitor } from './agent-health-monitor.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const T0 = new Date('2026-10-30T10:00:00.000Z');
const CAP_MS = 600_000;
const PLACED_MS = 120_000;
const START_TIMEOUT_MS = 60_000;
const TIMINGS = { enabled: true, capacityWaitTimeoutMs: CAP_MS, placedStartTimeoutMs: PLACED_MS };

const at = (ms: number) => new Date(T0.getTime() + ms);
const sameTime = (a: Date | null, b: Date | null) =>
  a === b || (a !== null && b !== null && a.getTime() === b.getTime());

type Observation =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; context: Record<string, unknown> } };

const QUEUED: Observation = { ok: true, data: { kind: 'queued' } };
const NOT_FOUND: Observation = { ok: false, error: { code: RUNTIME_ERROR_CODES.NOT_FOUND, message: 'missing', context: {} } };
const INSPECT_FAILED: Observation = { ok: false, error: { code: RUNTIME_ERROR_CODES.INSPECT_FAILED, message: 'api down', context: {} } };
const placed = (placedAt: Date, allocationId = 'alloc-1'): Observation => ({
  ok: true,
  data: { kind: 'placed', placedAt, allocationId, nodeId: 'node-1' },
});

interface SessionRow {
  id: string;
  agentId: string;
  status: string;
  startedAt: Date;
  runtimeRegisteredAt: Date | null;
  firstPlacedAt: Date | null;
  placementAllocationId: string | null;
}

interface HarnessOptions {
  row?: Partial<SessionRow>;
  gateEnabled?: boolean;
  supportsObservation?: boolean;
  queue?: Array<Array<Record<string, unknown>>>;
}

/**
 * Fake session state. The session-manager mock applies the same guards as the repository
 * (registration NULL-only, placement monotonic, claims on expected status and facts, no resurrection),
 * so these tests exercise the monitor's decisions; repository guards are covered by the DB integration tests.
 */
function createHarness(options: HarnessOptions = {}) {
  const row: SessionRow = {
    id: 'sess-1',
    agentId: 'agent-1',
    status: 'launching',
    startedAt: T0,
    runtimeRegisteredAt: null,
    firstPlacedAt: null,
    placementAllocationId: null,
    ...options.row,
  };
  const ended = () => row.status === 'stopped' || row.status === 'crashed';
  const hooks: { observe: () => Promise<Observation>; beforeClaim?: () => void } = {
    observe: async () => QUEUED,
  };
  const expiries: Array<{ reason: string; expected: unknown; claimed: boolean }> = [];
  const queue = [...(options.queue ?? [])];

  const observeStartup = vi.fn(() => hooks.observe());
  const launcher = {
    supportsStartupObservation: vi.fn(() => options.supportsObservation ?? true),
    observeStartup,
    getActiveRuntimes: vi.fn(() => []),
    stop: vi.fn(async () => ({ ok: true, data: undefined })),
    cleanupSessionDocuments: vi.fn(),
  };
  const sessionManager = {
    markUnhealthy: vi.fn(),
    handleStartTimeout: vi.fn(),
    recordRuntimeRegistered: vi.fn(async (_sessionId: string, registeredAt: Date) => {
      if (row.runtimeRegisteredAt === null && !ended()) row.runtimeRegisteredAt = registeredAt;
      return undefined;
    }),
    recordFirstPlacement: vi.fn(async (_sessionId: string, placedAt: Date, allocationId: string) => {
      if (!ended() && (row.firstPlacedAt === null || placedAt < row.firstPlacedAt)) {
        row.firstPlacedAt = placedAt;
        row.placementAllocationId = allocationId;
      }
      return undefined;
    }),
    expireStartupDeadline: vi.fn(async (_agentId: string, _sessionId: string, expected: any, reason: string) => {
      hooks.beforeClaim?.();
      hooks.beforeClaim = undefined;
      const claimed = row.status === expected.status
        && sameTime(row.runtimeRegisteredAt, expected.runtimeRegisteredAt)
        && sameTime(row.firstPlacedAt, expected.firstPlacedAt);
      expiries.push({ reason, expected, claimed });
      if (claimed) row.status = 'stopped';
      return claimed;
    }),
  };

  const db = {
    select: vi.fn((fields?: Record<string, unknown>) => ({
      from: () => ({
        where: async () => {
          if (!fields) return queue.shift() ?? [];
          if ('startedAt' in fields) return row.status === 'launching' ? [{ ...row }] : [];
          if ('id' in fields && Object.keys(fields).length === 1) return row.status === 'launching' ? [{ id: row.id }] : [];
          return [];
        },
      }),
    })),
  };

  const monitor = new AgentHealthMonitor(
    db as any,
    sessionManager as any,
    {
      checkIntervalMs: 1000,
      heartbeatTimeoutMs: 30_000,
      startTimeoutMs: START_TIMEOUT_MS,
      capacityAwareStart: { ...TIMINGS, enabled: options.gateEnabled ?? true },
    },
    launcher as any,
  );
  launcherByMonitor.set(monitor, launcher);

  return { monitor, row, hooks, expiries, observeStartup, sessionManager, launcher };
}

// The monitor takes its launcher explicitly for the sweep (production passes this.runtimeLauncher).
// The harness records which launcher it wired to each monitor so sweep() passes the same one.
const launcherByMonitor = new WeakMap<AgentHealthMonitor, unknown>();
const sweep = (monitor: AgentHealthMonitor) =>
  (monitor as any).sweepLaunchingSessions(launcherByMonitor.get(monitor)) as Promise<void>;
const setNow = (ms: number) => vi.setSystemTime(at(ms));

describe('AgentHealthMonitor capacity-aware startup', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('gate', () => {
    it('keeps launching sessions on the legacy startTimeoutMs path when the gate is off', async () => {
      const h = createHarness({
        gateEnabled: false,
        queue: [[], [{ id: 'sess-1', agentId: 'agent-1', startedAt: T0 }]],
      });
      const sweepSpy = vi.spyOn(h.monitor as any, 'sweepLaunchingSessions');
      setNow(61_000);

      await (h.monitor as any).checkHealth();

      expect(h.sessionManager.handleStartTimeout).toHaveBeenCalledWith('sess-1');
      expect(sweepSpy).not.toHaveBeenCalled();
      expect(h.observeStartup).not.toHaveBeenCalled();
    });

    it('keeps launching sessions on the legacy path when the runtime cannot observe startup', async () => {
      const h = createHarness({
        supportsObservation: false,
        queue: [[], [{ id: 'sess-1', agentId: 'agent-1', startedAt: T0 }]],
      });
      const sweepSpy = vi.spyOn(h.monitor as any, 'sweepLaunchingSessions');
      setNow(61_000);

      await (h.monitor as any).checkHealth();

      expect(h.sessionManager.handleStartTimeout).toHaveBeenCalledWith('sess-1');
      expect(sweepSpy).not.toHaveBeenCalled();
    });

    it('leaves starting sessions on startTimeoutMs when the gate is on', async () => {
      const h = createHarness({
        row: { status: 'starting' },
        queue: [[], [{ id: 'sess-1', agentId: 'agent-1', startedAt: T0 }]],
      });
      setNow(61_000);

      await (h.monitor as any).checkHealth();

      expect(h.sessionManager.handleStartTimeout).toHaveBeenCalledWith('sess-1');
    });

    it('runs the launching sweep and skips launching sessions in the legacy start query when the gate is on', async () => {
      const h = createHarness({
        queue: [[], []],
      });
      const sweepSpy = vi.spyOn(h.monitor as any, 'sweepLaunchingSessions');
      setNow(61_000);

      await (h.monitor as any).checkHealth();

      expect(sweepSpy).toHaveBeenCalledTimes(1);
      expect(h.sessionManager.handleStartTimeout).not.toHaveBeenCalled();
    });
  });

  describe('queue and boot deadlines', () => {
    it('does not time out a queued session before the capacity deadline', async () => {
      const h = createHarness();
      h.hooks.observe = async () => QUEUED;
      setNow(CAP_MS - 1_000);

      await sweep(h.monitor);

      expect(h.expiries).toHaveLength(0);
      expect(h.row.status).toBe('launching');
      expect(h.row.runtimeRegisteredAt).toEqual(T0);
      expect(h.row.firstPlacedAt).toBeNull();
    });

    it('expires a queued session at the capacity deadline with the queue reason', async () => {
      const h = createHarness();
      setNow(CAP_MS);

      await sweep(h.monitor);

      expect(h.expiries).toEqual([
        {
          reason: 'queue_deadline',
          expected: { status: 'launching', runtimeRegisteredAt: T0, firstPlacedAt: null },
          claimed: true,
        },
      ]);
      expect(h.row.status).toBe('stopped');
    });

    it('applies the boot deadline from the first placement', async () => {
      const h = createHarness({ row: { runtimeRegisteredAt: T0 } });
      h.hooks.observe = async () => placed(at(60_000));
      setNow(60_000);

      await sweep(h.monitor);

      expect(h.row.firstPlacedAt).toEqual(at(60_000));
      expect(h.row.placementAllocationId).toBe('alloc-1');

      setNow(60_000 + PLACED_MS - 1_000);
      await sweep(h.monitor);
      expect(h.expiries).toHaveLength(0);

      setNow(60_000 + PLACED_MS);
      await sweep(h.monitor);
      expect(h.expiries).toHaveLength(1);
      expect(h.expiries[0]).toMatchObject({ reason: 'boot_deadline', claimed: true });
      expect(h.observeStartup).toHaveBeenCalledTimes(1);
    });

    it('caps a late placement at the overall bound', async () => {
      const h = createHarness({ row: { runtimeRegisteredAt: T0 } });
      h.hooks.observe = async () => placed(at(CAP_MS + 100_000));
      setNow(CAP_MS + 100_000);

      await sweep(h.monitor);
      expect(h.expiries).toHaveLength(0);

      setNow(CAP_MS + PLACED_MS);
      await sweep(h.monitor);
      expect(h.expiries).toHaveLength(1);
      expect(h.expiries[0].reason).toBe('boot_deadline');
    });

    it('lets an earlier placement found before expiry replace the queue deadline', async () => {
      const h = createHarness({ row: { runtimeRegisteredAt: T0 } });
      h.hooks.observe = async () => placed(at(CAP_MS - 10_000));
      setNow(CAP_MS + 1_000);

      await sweep(h.monitor);

      expect(h.expiries).toHaveLength(0);
      expect(h.row.firstPlacedAt).toEqual(at(CAP_MS - 10_000));

      setNow(CAP_MS - 10_000 + PLACED_MS);
      await sweep(h.monitor);
      expect(h.expiries).toHaveLength(1);
      expect(h.expiries[0].reason).toBe('boot_deadline');
    });

    it('does not re-observe a session whose placement is already recorded', async () => {
      const h = createHarness({ row: { runtimeRegisteredAt: T0, firstPlacedAt: at(30_000), placementAllocationId: 'alloc-early' } });
      setNow(40_000);

      await sweep(h.monitor);

      expect(h.observeStartup).not.toHaveBeenCalled();
      expect(h.row.firstPlacedAt).toEqual(at(30_000));
      expect(h.row.placementAllocationId).toBe('alloc-early');
    });
  });

  describe('observation failures', () => {
    it('does not extend the queue deadline when inspection keeps failing', async () => {
      const h = createHarness({ row: { runtimeRegisteredAt: T0 } });
      h.hooks.observe = async () => INSPECT_FAILED;

      setNow(CAP_MS - 1_000);
      await sweep(h.monitor);
      expect(h.expiries).toHaveLength(0);

      setNow(CAP_MS);
      await sweep(h.monitor);

      expect(h.expiries).toHaveLength(1);
      expect(h.expiries[0].reason).toBe('queue_deadline');
      expect(h.sessionManager.recordFirstPlacement).not.toHaveBeenCalled();
    });

    it('keeps the absolute bound for an unregistered session whose scheduler state is unknown', async () => {
      const h = createHarness();
      h.hooks.observe = async () => INSPECT_FAILED;

      setNow(CAP_MS + PLACED_MS - 1_000);
      await sweep(h.monitor);
      expect(h.expiries).toHaveLength(0);

      setNow(CAP_MS + PLACED_MS);
      await sweep(h.monitor);

      expect(h.expiries).toHaveLength(1);
      expect(h.expiries[0].reason).toBe('observation_failure');
      expect(h.sessionManager.recordRuntimeRegistered).not.toHaveBeenCalled();
    });

    it('uses the legacy start budget for an unregistered session the scheduler confirms missing', async () => {
      const h = createHarness();
      h.hooks.observe = async () => NOT_FOUND;

      setNow(START_TIMEOUT_MS - 1_000);
      await sweep(h.monitor);
      expect(h.expiries).toHaveLength(0);

      setNow(START_TIMEOUT_MS);
      await sweep(h.monitor);

      expect(h.expiries).toHaveLength(1);
      expect(h.expiries[0].reason).toBe('start_timeout');
    });
  });

  describe('stop and races', () => {
    it('lets a stop win over a placement observed during the scheduler call', async () => {
      const h = createHarness({ row: { runtimeRegisteredAt: T0 } });
      h.hooks.observe = async () => {
        h.row.status = 'stopped';
        return placed(at(CAP_MS + 1_000));
      };
      setNow(CAP_MS + 1_000);

      await sweep(h.monitor);

      expect(h.row.firstPlacedAt).toBeNull();
      expect(h.row.status).toBe('stopped');
      expect(h.expiries).toHaveLength(0);
    });

    it('lets a stop win over a registration observed during the scheduler call', async () => {
      const h = createHarness();
      h.hooks.observe = async () => {
        h.row.status = 'stopped';
        return QUEUED;
      };
      setNow(1_000);

      await sweep(h.monitor);

      expect(h.row.runtimeRegisteredAt).toBeNull();
      expect(h.row.status).toBe('stopped');
      expect(h.expiries).toHaveLength(0);
    });

    it('fails a stale expiry claim when a placement lands first and re-evaluates', async () => {
      const h = createHarness({ row: { runtimeRegisteredAt: T0 } });
      h.hooks.observe = async () => QUEUED;
      h.hooks.beforeClaim = () => {
        h.row.firstPlacedAt = at(CAP_MS - 5_000);
        h.row.placementAllocationId = 'alloc-late';
      };
      setNow(CAP_MS + 1_000);

      await sweep(h.monitor);

      expect(h.expiries).toHaveLength(1);
      expect(h.expiries[0].claimed).toBe(false);
      expect(h.row.status).toBe('launching');
      expect(h.observeStartup).toHaveBeenCalledTimes(1);
    });

    it('fails a stale expiry claim when a heartbeat marks the session running', async () => {
      const h = createHarness({ row: { runtimeRegisteredAt: T0 } });
      h.hooks.observe = async () => QUEUED;
      h.hooks.beforeClaim = () => {
        h.row.status = 'running';
      };
      setNow(CAP_MS + 1_000);

      await sweep(h.monitor);

      expect(h.expiries).toHaveLength(1);
      expect(h.expiries[0].claimed).toBe(false);
      expect(h.row.status).toBe('running');
      expect(h.launcher.stop).not.toHaveBeenCalled();
    });
  });

  describe('scheduling', () => {
    it('does not start a second sweep while one is in flight', async () => {
      const h = createHarness();
      let release: (value: Observation) => void = () => {};
      h.hooks.observe = () => new Promise<Observation>((resolve) => {
        release = resolve;
      });

      const first = sweep(h.monitor);
      const second = sweep(h.monitor);
      await second;

      await vi.waitFor(() => expect(h.observeStartup).toHaveBeenCalledTimes(1));
      release(QUEUED);
      await first;
      expect(h.observeStartup).toHaveBeenCalledTimes(1);
    });

    it('does not block the health sweep on a slow scheduler call', async () => {
      const h = createHarness({ queue: [[], []] });
      h.hooks.observe = () => new Promise<Observation>(() => {});
      const sweepSpy = vi.spyOn(h.monitor as any, 'sweepLaunchingSessions');

      await expect((h.monitor as any).checkHealth()).resolves.toBeUndefined();
      expect(sweepSpy).toHaveBeenCalledTimes(1);
    });
  });
});

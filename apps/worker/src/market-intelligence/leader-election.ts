import type { Redis } from 'ioredis';
import { createLogger } from '../logger.js';

const logger = createLogger('market-intel-leader');

const LEADER_KEY = 'market-intel:leader';
const HEALTH_KEY = 'market-intel:health';
const DEFAULT_TTL_SECONDS = 20;
const RENEWAL_INTERVAL_FACTOR = 0.4;

export interface LeaderElectionConfig {
  workerId: string;
  ttlSeconds?: number;
}

export interface LeaderElection {
  acquire(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<void>;
  isLeader(): boolean;
  start(onAcquired: () => void, onLost: () => void): void;
  stop(): Promise<void>;
}

export function createLeaderElection(redis: Redis, config: LeaderElectionConfig): LeaderElection {
  const ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const renewalMs = Math.floor(ttlSeconds * 1000 * RENEWAL_INTERVAL_FACTOR);
  let leader = false;
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  let acquireTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  async function acquire(): Promise<boolean> {
    const value = JSON.stringify({
      workerId: config.workerId,
      startedAt: new Date().toISOString(),
    });
    const result = await redis.set(LEADER_KEY, value, 'EX', ttlSeconds, 'NX');
    if (result === 'OK') {
      leader = true;
      await updateHealth();
      return true;
    }
    return false;
  }

  async function renew(): Promise<boolean> {
    const script = `
      local val = redis.call("get", KEYS[1])
      if val then
        local data = cjson.decode(val)
        if data.workerId == ARGV[1] then
          redis.call("expire", KEYS[1], tonumber(ARGV[2]))
          return 1
        end
      end
      return 0
    `;
    const result = await redis.eval(script, 1, LEADER_KEY, config.workerId, String(ttlSeconds)) as number;
    if (result === 1) {
      await updateHealth();
      return true;
    }
    leader = false;
    return false;
  }

  async function release(): Promise<void> {
    const script = `
      local val = redis.call("get", KEYS[1])
      if val then
        local data = cjson.decode(val)
        if data.workerId == ARGV[1] then
          redis.call("del", KEYS[1])
          return 1
        end
      end
      return 0
    `;
    await redis.eval(script, 1, LEADER_KEY, config.workerId);
    leader = false;
  }

  async function updateHealth(): Promise<void> {
    const health = JSON.stringify({
      workerId: config.workerId,
      lastRenewedAt: new Date().toISOString(),
    });
    await redis.set(HEALTH_KEY, health, 'EX', ttlSeconds * 2).catch((err) => {
      logger.warn({ err }, 'Failed to update leader health key');
    });
  }

  function isLeaderFn(): boolean {
    return leader;
  }

  function start(onAcquired: () => void, onLost: () => void): void {
    stopped = false;

    // Attempt acquisition immediately and then retry on interval
    void (async () => {
      const acquired = await acquire().catch((err) => {
        logger.error({ err }, 'Leader acquisition failed');
        return false;
      });
      if (acquired) {
        logger.info({ workerId: config.workerId }, 'Acquired market-intel leadership');
        onAcquired();
        startRenewal(onAcquired, onLost);
      } else {
        startAcquireLoop(onAcquired, onLost);
      }
    })();
  }

  function startRenewal(onAcquired: () => void, onLost: () => void): void {
    clearInterval(renewTimer);
    renewTimer = setInterval(async () => {
      if (stopped) return;
      const renewed = await renew().catch((err) => {
        logger.error({ err }, 'Leader renewal failed');
        return false;
      });
      if (!renewed) {
        logger.warn({ workerId: config.workerId }, 'Lost market-intel leadership');
        clearInterval(renewTimer);
        onLost();
        if (!stopped) {
          // Pass the original onAcquired so coordinator loops restart on re-acquisition
          startAcquireLoop(onAcquired, onLost);
        }
      }
    }, renewalMs);
  }

  function startAcquireLoop(onAcquired: () => void, onLost: () => void): void {
    clearInterval(acquireTimer);
    // Retry at TTL interval (wait for current leader to expire)
    acquireTimer = setInterval(async () => {
      if (stopped) return;
      const acquired = await acquire().catch((err) => {
        logger.error({ err }, 'Leader re-acquisition failed');
        return false;
      });
      if (acquired) {
        logger.info({ workerId: config.workerId }, 'Acquired market-intel leadership');
        clearInterval(acquireTimer);
        onAcquired();
        startRenewal(onAcquired, onLost);
      }
    }, ttlSeconds * 1000);
  }

  async function stop(): Promise<void> {
    stopped = true;
    clearInterval(renewTimer);
    clearInterval(acquireTimer);
    if (leader) {
      await release().catch((err) => {
        logger.error({ err }, 'Failed to release leadership on stop');
      });
    }
  }

  return {
    acquire,
    renew,
    release,
    isLeader: isLeaderFn,
    start,
    stop,
  };
}

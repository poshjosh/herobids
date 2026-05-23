import type { Redis } from 'ioredis';

const LEASE_PREFIX = 'lease:instance:';

/**
 * InstanceLease — distributed lock for trading instance ownership.
 *
 * Uses Redis SET NX EX to ensure only one worker runs each instance.
 * Workers must renew the lease periodically (< ttl) or it expires,
 * allowing another worker to claim the instance.
 */
export class InstanceLease {
  private readonly renewTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly redis: Redis,
    private readonly workerId: string,
    private readonly ttlSeconds: number = 30,
  ) {}

  /**
   * Attempt to acquire the lease for an instance.
   * Returns true if acquired (this worker now owns it), false if another worker holds it.
   */
  async acquire(instanceId: string): Promise<boolean> {
    const key = LEASE_PREFIX + instanceId;
    const result = await this.redis.set(key, this.workerId, 'EX', this.ttlSeconds, 'NX');
    if (result !== 'OK') return false;

    // Start renewal timer at half the TTL
    this.startRenewal(instanceId);
    return true;
  }

  /**
   * Release the lease for an instance (only if we still own it).
   * Uses a Lua script for atomic check-and-delete.
   */
  async release(instanceId: string): Promise<boolean> {
    this.stopRenewal(instanceId);
    const key = LEASE_PREFIX + instanceId;
    // Atomic: only delete if the value matches our workerId
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await this.redis.eval(script, 1, key, this.workerId) as number;
    return result === 1;
  }

  /**
   * Renew the lease (extend TTL). Returns false if we no longer own it.
   */
  async renew(instanceId: string): Promise<boolean> {
    const key = LEASE_PREFIX + instanceId;
    // Atomic: only extend if we still own it
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("expire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await this.redis.eval(script, 1, key, this.workerId, String(this.ttlSeconds)) as number;
    return result === 1;
  }

  /**
   * Check who currently holds the lease (if anyone).
   */
  async holder(instanceId: string): Promise<string | null> {
    const key = LEASE_PREFIX + instanceId;
    return this.redis.get(key);
  }

  /**
   * Release all leases held by this worker and stop all renewal timers.
   */
  async releaseAll(instanceIds: string[]): Promise<void> {
    await Promise.allSettled(instanceIds.map((id) => this.release(id)));
  }

  /** Stop all renewal timers (for shutdown) */
  shutdown(): void {
    for (const timer of this.renewTimers.values()) {
      clearInterval(timer);
    }
    this.renewTimers.clear();
  }

  private startRenewal(instanceId: string): void {
    this.stopRenewal(instanceId); // Idempotent
    const interval = Math.floor(this.ttlSeconds * 1000 / 2);
    const timer = setInterval(async () => {
      const renewed = await this.renew(instanceId);
      if (!renewed) {
        // We lost the lease — stop renewal
        this.stopRenewal(instanceId);
      }
    }, interval);
    this.renewTimers.set(instanceId, timer);
  }

  private stopRenewal(instanceId: string): void {
    const timer = this.renewTimers.get(instanceId);
    if (timer) {
      clearInterval(timer);
      this.renewTimers.delete(instanceId);
    }
  }
}

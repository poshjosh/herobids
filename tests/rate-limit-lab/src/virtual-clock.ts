import type { RateBudgetClock } from './rate-limiter.js';

interface Sleeper {
  id: number;
  targetMs: number;
  resolve: () => void;
}

export class VirtualClock implements RateBudgetClock {
  private currentMs = 0;
  private nextId = 0;
  private sleepers: Sleeper[] = [];

  now(): number {
    return this.currentMs;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepers.push({
        id: this.nextId++,
        targetMs: this.currentMs + Math.max(0, Math.ceil(ms)),
        resolve,
      });
      this.sleepers.sort((left, right) => {
        if (left.targetMs !== right.targetMs) {
          return left.targetMs - right.targetMs;
        }
        return left.id - right.id;
      });
    });
  }

  hasPending(): boolean {
    return this.sleepers.length > 0;
  }

  async advanceToNextEvent(): Promise<boolean> {
    if (this.sleepers.length === 0) {
      return false;
    }

    const nextTarget = this.sleepers[0]?.targetMs ?? this.currentMs;
    this.currentMs = nextTarget;

    while (true) {
      const due = this.sleepers.filter((sleeper) => sleeper.targetMs <= this.currentMs);
      if (due.length === 0) {
        break;
      }

      this.sleepers = this.sleepers.filter((sleeper) => sleeper.targetMs > this.currentMs);
      for (const sleeper of due) {
        sleeper.resolve();
      }
      await flushMicrotasks();
    }

    return true;
  }
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
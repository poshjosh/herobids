import type { Price } from '@herobids/domain';

/**
 * A single historical market event frame used for replay.
 * Events MUST be ordered by timestamp ascending.
 */
export interface HistoricalFrame {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Symbol this frame belongs to */
  symbol: string;
  /** Price at this point in time */
  price: Price;
  /** Optional additional context data passed to the strategy via MarketSnapshot.data */
  data?: Record<string, unknown>;
}

/**
 * Historical data feed — yields ordered frames for replay.
 * Implementations may load from DB, CSV, or in-memory arrays.
 */
export interface HistoricalDataFeed {
  /** Total number of frames available */
  readonly length: number;
  /** Get the frame at a given index (0-based) */
  frame(index: number): HistoricalFrame;
}

/**
 * In-memory historical data feed backed by a pre-loaded array.
 */
export class ArrayHistoricalDataFeed implements HistoricalDataFeed {
  private readonly frames: HistoricalFrame[];

  constructor(frames: HistoricalFrame[]) {
    if (frames.length === 0) {
      throw new Error('Historical data feed must have at least one frame');
    }
    // Validate ordering
    for (let i = 1; i < frames.length; i++) {
      if (frames[i]!.timestamp < frames[i - 1]!.timestamp) {
        throw new Error(`Frames must be ordered by timestamp ascending (violation at index ${i})`);
      }
    }
    this.frames = frames;
  }

  get length(): number {
    return this.frames.length;
  }

  frame(index: number): HistoricalFrame {
    const f = this.frames[index];
    if (!f) throw new Error(`Frame index ${index} out of bounds (length: ${this.frames.length})`);
    return f;
  }
}

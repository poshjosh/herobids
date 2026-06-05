import type { MarkSource, Mark, MarkError } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok, err, price } from '@herobids/domain';

export interface FillRecord {
  price: string;
  filledAt: string;
}

export interface FillLookup {
  getLatestFillByInstrument(instrument: string, actorId?: string): Promise<FillRecord | null>;
}

/**
 * LastFillMarkSource — derives mark price from the most recent fill for an instrument.
 * Used as primary mark source when fills are recent (within staleness threshold).
 */
export class LastFillMarkSource implements MarkSource {
  constructor(
    private readonly fillLookup: FillLookup,
    private readonly actorId?: string,
  ) {}

  async fetchMark(instrument: string): Promise<Result<Mark, MarkError>> {
    const fill = await this.fillLookup.getLatestFillByInstrument(instrument, this.actorId);
    if (!fill) {
      return err({
        code: 'mark.no_fill',
        message: `No fills found for instrument: ${instrument}`,
      });
    }

    return ok({
      price: price(fill.price),
      source: 'last_fill' as const,
      instrument,
      timestamp: fill.filledAt,
    });
  }
}

export interface MarkSelectorConfig {
  stalenessThresholdMs: number;
}

/**
 * MarkSelector — composites LastFillMarkSource and a fallback (oracle).
 * Uses last fill if recent (< stalenessThreshold); falls back to oracle otherwise.
 * Implements MarkSource itself so consumers don't need to know about the dual-source logic.
 */
export class MarkSelector implements MarkSource {
  constructor(
    private readonly config: MarkSelectorConfig,
    private readonly lastFillSource: MarkSource,
    private readonly fallbackSource: MarkSource,
  ) {}

  async fetchMark(instrument: string): Promise<Result<Mark, MarkError>> {
    const fillResult = await this.lastFillSource.fetchMark(instrument);

    if (fillResult.ok) {
      const fillAge = Date.now() - new Date(fillResult.data.timestamp).getTime();
      if (fillAge < this.config.stalenessThresholdMs) {
        return fillResult;
      }
      // Fill is stale — fall through to oracle
    }

    // No fill or stale fill — use fallback
    const fallbackResult = await this.fallbackSource.fetchMark(instrument);
    if (fallbackResult.ok) {
      return fallbackResult;
    }

    // If oracle also fails and we had a stale fill, return it marked as stale
    // so callers with a fresher price source (e.g. live ticker) can prefer their own.
    if (fillResult.ok) {
      return ok({ ...fillResult.data, stale: true });
    }

    // Both failed
    return err({
      code: 'mark.unavailable',
      message: `No mark available for ${instrument}: fill source (${fillResult.ok ? 'stale' : fillResult.error.message}), fallback (${fallbackResult.error.message})`,
    });
  }
}

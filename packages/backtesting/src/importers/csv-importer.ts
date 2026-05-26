import { price } from '@herobids/domain';
import type { HistoricalFrame } from '../historical-data-feed.js';

/**
 * CSV column mapping for import.
 */
export interface CsvColumnMapping {
  /** Column index (0-based) for the timestamp field (ISO 8601 or Unix ms) */
  timestamp: number;
  /** Column index for the price field */
  price: number;
  /** Column index for volume (optional) */
  volume?: number;
  /** Column index for high (optional, for OHLC) */
  high?: number;
  /** Column index for low (optional, for OHLC) */
  low?: number;
  /** Column index for open (optional, for OHLC) */
  open?: number;
  /** Column index for close (optional, for OHLC — used as price if price is absent) */
  close?: number;
}

export interface CsvImportOptions {
  symbol: string;
  columns: CsvColumnMapping;
  /** Skip the first N rows (e.g. 1 for header) */
  skipRows?: number;
  /** CSV delimiter. Default: ',' */
  delimiter?: string;
}

/**
 * Parse CSV text into historical frames for backtesting.
 * Validates ordering and rejects gaps or invalid data loudly.
 */
export function parseCsvToFrames(csvText: string, options: CsvImportOptions): HistoricalFrame[] {
  const delimiter = options.delimiter ?? ',';
  const lines = csvText.split('\n').filter((l) => l.trim().length > 0);
  const skipRows = options.skipRows ?? 0;
  const dataLines = lines.slice(skipRows);

  if (dataLines.length === 0) {
    throw new Error('CSV contains no data rows after skipping headers');
  }

  const frames: HistoricalFrame[] = [];

  for (let i = 0; i < dataLines.length; i++) {
    const cols = dataLines[i]!.split(delimiter).map((c) => c.trim());

    const rawTimestamp = cols[options.columns.timestamp];
    const rawPrice = cols[options.columns.price];

    if (!rawTimestamp || !rawPrice) {
      throw new Error(`CSV row ${i + skipRows + 1}: missing timestamp or price`);
    }

    // Parse timestamp: support ISO 8601 or Unix milliseconds
    let timestamp: string;
    const asNum = Number(rawTimestamp);
    let parsedDate: Date;
    if (!isNaN(asNum) && rawTimestamp.length >= 10) {
      // Unix timestamp (seconds or milliseconds)
      const ms = asNum > 1e12 ? asNum : asNum * 1000;
      parsedDate = new Date(ms);
    } else {
      parsedDate = new Date(rawTimestamp);
    }

    if (isNaN(parsedDate.getTime())) {
      throw new Error(`CSV row ${i + skipRows + 1}: invalid timestamp "${rawTimestamp}"`);
    }
    timestamp = parsedDate.toISOString();

    const priceVal = Number(rawPrice);
    if (isNaN(priceVal) || priceVal <= 0) {
      throw new Error(`CSV row ${i + skipRows + 1}: invalid price "${rawPrice}"`);
    }

    const data: Record<string, unknown> = {};
    if (options.columns.volume !== undefined && cols[options.columns.volume]) {
      data['volume'] = cols[options.columns.volume];
    }
    if (options.columns.open !== undefined && cols[options.columns.open]) {
      data['open'] = cols[options.columns.open];
    }
    if (options.columns.high !== undefined && cols[options.columns.high]) {
      data['high'] = cols[options.columns.high];
    }
    if (options.columns.low !== undefined && cols[options.columns.low]) {
      data['low'] = cols[options.columns.low];
    }
    if (options.columns.close !== undefined && cols[options.columns.close]) {
      data['close'] = cols[options.columns.close];
    }

    frames.push({
      timestamp,
      symbol: options.symbol,
      price: price(rawPrice),
      data: Object.keys(data).length > 0 ? data : undefined,
    });
  }

  // Validate ordering
  for (let i = 1; i < frames.length; i++) {
    if (frames[i]!.timestamp < frames[i - 1]!.timestamp) {
      throw new Error(
        `CSV data is not time-ordered: row ${i + skipRows + 1} (${frames[i]!.timestamp}) is before row ${i + skipRows} (${frames[i - 1]!.timestamp})`,
      );
    }
  }

  return frames;
}

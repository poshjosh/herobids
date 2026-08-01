/**
 * Parses and validates swap instrument IDs.
 *
 * Accepts three forms:
 *   - BASE/QUOTE                  legacy plain pair (e.g. "BONK/USDC")
 *   - BASE:BASE_ID/QUOTE           base-qualified (e.g. "BONK:DezXAZ8.../USDC")
 *   - BASE:BASE_ID/QUOTE:QUOTE_ID  exact scanner ID (e.g. "BONK:DezXAZ8.../USDC:EPjFWdd5...")
 *
 * Returns a typed result — throws on malformed input.  Callers that prefer
 * a Result wrapper should catch and wrap.
 */

export interface ParsedSwapInstrument {
  /** Human-readable display label, e.g. "BONK/USDC" */
  displaySymbol: string;
  /** Base token ticker */
  baseSymbol: string;
  /** Base token on-chain address, or null when not supplied */
  baseAddress: string | null;
  /** Quote token ticker */
  quoteSymbol: string;
  /** Quote token on-chain address, or null when not supplied */
  quoteAddress: string | null;
  /** True when both baseAddress and quoteAddress are present */
  isExact: boolean;
}

/** Error thrown by parseSwapInstrumentId on malformed input. */
export class SwapInstrumentParseError extends Error {
  constructor(
    message: string,
    public readonly instrumentId: string,
  ) {
    super(message);
    this.name = 'SwapInstrumentParseError';
  }
}

/** Parse a swap instrument ID into its constituents. */
export function parseSwapInstrumentId(instrumentId: string): ParsedSwapInstrument {
  // TODO(Phase 5): wrap in Result — public APIs must return Result<T, E> per AGENTS.md
  // Empty / blank
  if (!instrumentId || instrumentId.trim().length === 0) {
    throw new SwapInstrumentParseError('Instrument ID must not be empty', instrumentId);
  }

  // Too many slashes — more than 1 is invalid
  const slashCount = (instrumentId.match(/\//g) ?? []).length;
  if (slashCount === 0) {
    throw new SwapInstrumentParseError(
      `Instrument ID must contain a '/' separator (e.g. 'WETH/USDC'). Got: '${instrumentId}'`,
      instrumentId,
    );
  }
  if (slashCount > 1) {
    throw new SwapInstrumentParseError(
      `Instrument ID must contain exactly one '/' separator. Got: '${instrumentId}'`,
      instrumentId,
    );
  }

  const [rawBase, rawQuote] = instrumentId.split('/') as [string, string];

  // Parse base side: SYMBOL or SYMBOL:ADDRESS
  const baseParts = rawBase.split(':');
  if (baseParts.length > 2) {
    throw new SwapInstrumentParseError(
      `Base side must be 'SYMBOL' or 'SYMBOL:ADDRESS'. Got: '${rawBase}'`,
      instrumentId,
    );
  }
  const baseSymbol = baseParts[0]!.trim();
  const baseAddress = baseParts.length === 2 ? baseParts[1]!.trim() : null;

  if (baseSymbol.length === 0) {
    throw new SwapInstrumentParseError('Base symbol must not be empty', instrumentId);
  }
  if (baseAddress !== null && baseAddress.length === 0) {
    throw new SwapInstrumentParseError('Base address must not be empty when supplied', instrumentId);
  }

  // Parse quote side: SYMBOL or SYMBOL:ADDRESS
  const quoteParts = rawQuote.split(':');
  if (quoteParts.length > 2) {
    throw new SwapInstrumentParseError(
      `Quote side must be 'SYMBOL' or 'SYMBOL:ADDRESS'. Got: '${rawQuote}'`,
      instrumentId,
    );
  }
  const quoteSymbol = quoteParts[0]!.trim();
  const quoteAddress = quoteParts.length === 2 ? quoteParts[1]!.trim() : null;

  if (quoteSymbol.length === 0) {
    throw new SwapInstrumentParseError('Quote symbol must not be empty', instrumentId);
  }
  if (quoteAddress !== null && quoteAddress.length === 0) {
    throw new SwapInstrumentParseError('Quote address must not be empty when supplied', instrumentId);
  }

  const displaySymbol = `${baseSymbol}/${quoteSymbol}`;
  const isExact = baseAddress !== null && quoteAddress !== null;

  return { displaySymbol, baseSymbol, baseAddress, quoteSymbol, quoteAddress, isExact };
}

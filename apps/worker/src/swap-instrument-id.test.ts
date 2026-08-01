import { describe, it, expect } from 'vitest';
import { parseSwapInstrumentId, SwapInstrumentParseError } from './swap-instrument-id.js';

describe('parseSwapInstrumentId', () => {
  // ── Legacy plain pair ─────────────────────────────────────────────────────

  it('parses legacy BASE/QUOTE form', () => {
    const result = parseSwapInstrumentId('BONK/USDC');
    expect(result.displaySymbol).toBe('BONK/USDC');
    expect(result.baseSymbol).toBe('BONK');
    expect(result.baseAddress).toBeNull();
    expect(result.quoteSymbol).toBe('USDC');
    expect(result.quoteAddress).toBeNull();
    expect(result.isExact).toBe(false);
  });

  it('parses legacy form with different tickers', () => {
    const result = parseSwapInstrumentId('WETH/USDC');
    expect(result.displaySymbol).toBe('WETH/USDC');
    expect(result.baseSymbol).toBe('WETH');
    expect(result.quoteSymbol).toBe('USDC');
    expect(result.isExact).toBe(false);
  });

  // ── Base-qualified form ───────────────────────────────────────────────────

  it('parses BASE:BASE_ID/QUOTE form', () => {
    const result = parseSwapInstrumentId(
      'BONK:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/USDC',
    );
    expect(result.displaySymbol).toBe('BONK/USDC');
    expect(result.baseSymbol).toBe('BONK');
    expect(result.baseAddress).toBe('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(result.quoteSymbol).toBe('USDC');
    expect(result.quoteAddress).toBeNull();
    expect(result.isExact).toBe(false);
  });

  // ── Exact scanner ID ──────────────────────────────────────────────────────

  it('parses exact BASE:ADDR/QUOTE:ADDR form', () => {
    const result = parseSwapInstrumentId(
      'BONK:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/USDC:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    expect(result.displaySymbol).toBe('BONK/USDC');
    expect(result.baseSymbol).toBe('BONK');
    expect(result.baseAddress).toBe('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(result.quoteSymbol).toBe('USDC');
    expect(result.quoteAddress).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(result.isExact).toBe(true);
  });

  it('parses exact EVM pair', () => {
    const result = parseSwapInstrumentId(
      'WETH:0x4200000000000000000000000000000000000006/USDC:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    );
    expect(result.displaySymbol).toBe('WETH/USDC');
    expect(result.baseSymbol).toBe('WETH');
    expect(result.baseAddress).toBe('0x4200000000000000000000000000000000000006');
    expect(result.quoteSymbol).toBe('USDC');
    expect(result.quoteAddress).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(result.isExact).toBe(true);
  });

  // ── Whitespace trimming ───────────────────────────────────────────────────

  it('trims whitespace around symbols and addresses', () => {
    const result = parseSwapInstrumentId(' BONK : DezXAZ8... / USDC : EPjFWdd5... ');
    expect(result.baseSymbol).toBe('BONK');
    expect(result.baseAddress).toBe('DezXAZ8...');
    expect(result.quoteSymbol).toBe('USDC');
    expect(result.quoteAddress).toBe('EPjFWdd5...');
  });

  // ── Error: empty ──────────────────────────────────────────────────────────

  it('throws for empty instrument ID', () => {
    expect(() => parseSwapInstrumentId('')).toThrow(SwapInstrumentParseError);
    expect(() => parseSwapInstrumentId('  ')).toThrow(SwapInstrumentParseError);
  });

  // ── Error: no slash ───────────────────────────────────────────────────────

  it('throws when no "/" separator is present', () => {
    expect(() => parseSwapInstrumentId('BTC')).toThrow(SwapInstrumentParseError);
    expect(() => parseSwapInstrumentId('BTC:addr')).toThrow(SwapInstrumentParseError);
  });

  // ── Error: too many slashes ───────────────────────────────────────────────

  it('throws when more than one "/" is present', () => {
    expect(() => parseSwapInstrumentId('BASE/QUOTE/EXTRA')).toThrow(
      SwapInstrumentParseError,
    );
  });

  // ── Error: too many colons ────────────────────────────────────────────────

  it('throws when base side has too many colons', () => {
    expect(() =>
      parseSwapInstrumentId('A:B:C/QUOTE'),
    ).toThrow(SwapInstrumentParseError);
  });

  it('throws when quote side has too many colons', () => {
    expect(() =>
      parseSwapInstrumentId('BASE/A:B:C'),
    ).toThrow(SwapInstrumentParseError);
  });

  // ── Error: empty segments ─────────────────────────────────────────────────

  it('throws when base symbol is empty', () => {
    expect(() => parseSwapInstrumentId('/USDC')).toThrow(SwapInstrumentParseError);
  });

  it('throws when quote symbol is empty', () => {
    expect(() => parseSwapInstrumentId('WETH/')).toThrow(SwapInstrumentParseError);
  });

  it('throws when base address is empty colon', () => {
    expect(() => parseSwapInstrumentId('WETH:/USDC')).toThrow(
      SwapInstrumentParseError,
    );
  });

  it('throws when quote address is empty colon', () => {
    expect(() =>
      parseSwapInstrumentId('WETH/USDC:'),
    ).toThrow(SwapInstrumentParseError);
  });
});

function fmtScaled(n: number, divisor: number): string {
  const scaled = Math.abs(n) / divisor;
  if (scaled >= 100) {
    const fixed = scaled.toFixed(0);
    // When toFixed(0) rounds up to the next tier boundary (e.g. 999.5 → "1000"),
    // promote to the next tier instead of emitting "1000K" / "1000M" / "1000B".
    if (fixed === '1000') return '1.00';
    return fixed;
  }
  if (scaled >= 10) return scaled.toFixed(1);
  return scaled.toFixed(2);
}

/**
 * Compact number formatter — reduces token cost of large numeric values.
 *   fmtNum(1_234_567)  →  "1.23M"
 *   fmtNum(12_345)     →  "12.3K"
 *   fmtNum(987)        →  "987"
 *   fmtNum(0.000123)   →  "0.000123"  (pass-through below 1 000)
 */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';

  const TIERS: [number, string][] = [
    [1_000_000_000_000, 'T'],
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ];

  for (let i = 0; i < TIERS.length; i++) {
    const [divisor, suffix] = TIERS[i]!;
    if (abs >= divisor) {
      const result = fmtScaled(abs, divisor);
      // When rounding rolls us into the next tier (e.g. 999.5K → "1.00" → 1.00M),
      // promote to the higher-tier suffix.
      if (result === '1.00' && i > 0) {
        const [, nextSuffix] = TIERS[i - 1]!;
        if (Math.round(abs / divisor) >= 1000) {
          return `${sign}1.00${nextSuffix}`;
        }
      }
      return `${sign}${result}${suffix}`;
    }
  }
  return String(n);
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'unavailable';
  return `$${fmtNum(n)}`;
}

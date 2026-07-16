import { describe, it, expect } from 'vitest';
import {
  TechnicalConfigSchema,
  StrictTechnicalConfigSchema,
  type TechnicalConfig,
  type UnifiedAgentConfig,
} from '@herobids/domain';

/**
 * Pure helper that mirrors the config-resolution branching logic from
 * the worker's onSessionActive callback (Phase 1 scanner-gated hardening).
 *
 * Returns the parsed TechnicalConfig, or throws a ZodError if the strict
 * validation fails (for scanner_gated agents with incomplete persisted config).
 */
function resolveTechnicalConfig(
  rawTechnical: unknown,
  capabilityMode: UnifiedAgentConfig['capabilityMode'],
  hybridMode: UnifiedAgentConfig['hybridMode'],
): TechnicalConfig | undefined {
  if (capabilityMode === 'hybrid' && hybridMode === 'scanner_gated') {
    // Strict: reject incomplete scanner-gated configs entirely.
    // Throws ZodError if required fields (scanBatchSize, scanIntervalMs, etc.) are missing.
    const strictParsed = StrictTechnicalConfigSchema.parse(rawTechnical);
    return TechnicalConfigSchema.parse(strictParsed);
  }

  if (capabilityMode === 'hybrid' && hybridMode === 'mixed') {
    // Lenient: apply defaults as a repair step for mixed-mode agents.
    // Missing fields are filled from Zod defaults rather than crashing startup.
    return rawTechnical ? TechnicalConfigSchema.parse(rawTechnical) : undefined;
  }

  // intelligence agent — no technical config needed
  return undefined;
}

const validMinimalConfig = {
  filters: { venue: 'hyperliquid', venueType: 'orderbook' as const },
  indicators: {},
  candles: {},
  signalBias: 'trend-following' as const,
  scanIntervalMs: 60_000,
  scanBatchSize: 5,
  autonomousExit: false,
};

describe('scanner-gated config validation (worker startup path)', () => {
  describe('scanner_gated hybrid agent', () => {
    it('starts actor with valid complete config', () => {
      const result = resolveTechnicalConfig(
        validMinimalConfig,
        'hybrid',
        'scanner_gated',
      );
      expect(result).toBeDefined();
      expect(result?.scanBatchSize).toBe(5);
      expect(result?.scanIntervalMs).toBe(60_000);
      // Inner defaults still applied through the second parse
      expect(result?.candles.interval).toBe('15m');
    });

    it('rejects config missing scanBatchSize — validation fails, no actor created', () => {
      const incomplete = { ...validMinimalConfig };
      delete (incomplete as Record<string, unknown>).scanBatchSize;

      expect(() =>
        resolveTechnicalConfig(incomplete, 'hybrid', 'scanner_gated'),
      ).toThrow();
    });

    it('rejects config missing scanIntervalMs — validation fails', () => {
      const incomplete = { ...validMinimalConfig };
      delete (incomplete as Record<string, unknown>).scanIntervalMs;

      expect(() =>
        resolveTechnicalConfig(incomplete, 'hybrid', 'scanner_gated'),
      ).toThrow();
    });

    it('rejects config missing indicators object', () => {
      const incomplete = { ...validMinimalConfig };
      delete (incomplete as Record<string, unknown>).indicators;

      expect(() =>
        resolveTechnicalConfig(incomplete, 'hybrid', 'scanner_gated'),
      ).toThrow();
    });

    it('rejects config missing autonomousExit', () => {
      const incomplete = { ...validMinimalConfig };
      delete (incomplete as Record<string, unknown>).autonomousExit;

      expect(() =>
        resolveTechnicalConfig(incomplete, 'hybrid', 'scanner_gated'),
      ).toThrow();
    });
  });

  describe('mixed hybrid agent', () => {
    it('applies defaults for missing scanBatchSize — actor starts', () => {
      const incomplete = { ...validMinimalConfig };
      delete (incomplete as Record<string, unknown>).scanBatchSize;

      const result = resolveTechnicalConfig(incomplete, 'hybrid', 'mixed');
      expect(result).toBeDefined();
      expect(result?.scanBatchSize).toBe(5); // Zod default applied
    });

    it('applies defaults for missing scanIntervalMs', () => {
      const incomplete = { ...validMinimalConfig };
      delete (incomplete as Record<string, unknown>).scanIntervalMs;

      const result = resolveTechnicalConfig(incomplete, 'hybrid', 'mixed');
      expect(result).toBeDefined();
      expect(result?.scanIntervalMs).toBe(60_000); // Zod default applied
    });

    it('applies defaults for missing signalBias', () => {
      const incomplete = { ...validMinimalConfig };
      delete (incomplete as Record<string, unknown>).signalBias;

      const result = resolveTechnicalConfig(incomplete, 'hybrid', 'mixed');
      expect(result).toBeDefined();
      expect(result?.signalBias).toBe('trend-following'); // Zod default applied
    });

    it('returns undefined when no technical block is provided', () => {
      const result = resolveTechnicalConfig(undefined, 'hybrid', 'mixed');
      expect(result).toBeUndefined();
    });
  });

  describe('intelligence agent', () => {
    it('returns undefined — no technical config needed, starts normally', () => {
      const result = resolveTechnicalConfig(
        validMinimalConfig,
        'intelligence',
        undefined,
      );
      expect(result).toBeUndefined();
    });

    it('returns undefined even when technical block is absent entirely', () => {
      const result = resolveTechnicalConfig(
        undefined,
        'intelligence',
        undefined,
      );
      expect(result).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('hybrid without hybridMode currently falls through to intelligence path (no technical needed)', () => {
      // This case occurs if the agent was created before hybridMode was added.
      // The worker treats it as intelligence (no tech config), which is safe —
      // it won't start a broken scan loop.
      const result = resolveTechnicalConfig(
        validMinimalConfig,
        'hybrid',
        undefined,
      );
      expect(result).toBeUndefined();
    });

    it('rejects scanBatchSize of 0 even for scanner_gated (below min=1)', () => {
      expect(() =>
        resolveTechnicalConfig(
          { ...validMinimalConfig, scanBatchSize: 0 },
          'hybrid',
          'scanner_gated',
        ),
      ).toThrow();
    });

    it('rejects scanIntervalMs below 10_000 for scanner_gated', () => {
      expect(() =>
        resolveTechnicalConfig(
          { ...validMinimalConfig, scanIntervalMs: 5_000 },
          'hybrid',
          'scanner_gated',
        ),
      ).toThrow();
    });
  });
});

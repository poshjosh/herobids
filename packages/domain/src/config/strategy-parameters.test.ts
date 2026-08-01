import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import {
  initStrategyRegistry,
  getStrategyParameters,
  isStrategySupported,
  validateStrategyParams,
  listStrategyCombinations,
} from './strategy-parameters.js';

describe('StrategyParameterRegistry', () => {
  // Initialize the registry with test schemas before tests
  const testMechanicalSchema = z.object({
    stopLossPct: z.number().min(0).max(100),
    takeProfitPct: z.number().min(0),
  });

  const testHybridSchema = z.object({
    mechanical: testMechanicalSchema,
    provider: z.string().optional(),
  });

  beforeAll(() => {
    initStrategyRegistry({
      mechanical: testMechanicalSchema,
      hybrid: testHybridSchema,
      llm: z.object({ provider: z.string() }),
      empty: z.object({}).strict(),
    });
  });

  it('DCA has empty params for all decision modes', () => {
    for (const mode of ['mechanical', 'llm', 'hybrid'] as const) {
      const entry = getStrategyParameters('dca', mode);
      expect(entry).toBeDefined();
      expect(entry!.defaults).toEqual({});
      expect(entry!.schema.parse({})).toEqual({});
    }
  });

  it('momentum:mechanical uses MechanicalParamsSchema', () => {
    const entry = getStrategyParameters('momentum', 'mechanical');
    expect(entry).toBeDefined();
    const result = entry!.schema.parse({ stopLossPct: 5, takeProfitPct: 10 });
    expect(result.stopLossPct).toBe(5);
  });

  it('momentum:hybrid uses HybridParamsSchema', () => {
    const entry = getStrategyParameters('momentum', 'hybrid');
    expect(entry).toBeDefined();
    const result = entry!.schema.parse({
      mechanical: { stopLossPct: 5, takeProfitPct: 10 },
      provider: 'openrouter',
    });
    expect(result.mechanical.stopLossPct).toBe(5);
  });

  it('isStrategySupported returns false for unknown types', () => {
    expect(isStrategySupported('unknown_type')).toBe(false);
    expect(isStrategySupported('momentum')).toBe(true);
  });

  it('validateStrategyParams throws for unsupported type', () => {
    expect(() => validateStrategyParams('unknown', 'mechanical', {}))
      .toThrow('Unsupported strategy');
  });

  it('validateStrategyParams validates params through registry', () => {
    const result = validateStrategyParams('momentum', 'mechanical', {
      stopLossPct: 5,
      takeProfitPct: 10,
    });
    expect(result.stopLossPct).toBe(5);
  });

  it('validateStrategyParams rejects invalid params', () => {
    expect(() => validateStrategyParams('momentum', 'mechanical', {
      stopLossPct: 500, // exceeds max 100
    })).toThrow();
  });

  it('listStrategyCombinations returns all registered combos', () => {
    const combos = listStrategyCombinations();
    expect(combos.length).toBeGreaterThan(0);
    // DCA should be registered for all 3 modes
    const dcaCombos = combos.filter(c => c.type === 'dca');
    expect(dcaCombos.length).toBe(3);
  });

  it('defaults decisionMode to mechanical when undefined', () => {
    const entry = getStrategyParameters('momentum');
    expect(entry).toBeDefined();
  });
});

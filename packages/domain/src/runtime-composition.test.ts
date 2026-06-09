import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_BUDGETS, initDefaultRuntimeBudgets } from './runtime-composition.js';

const TEST_DEFAULTS = {
  maxHistoryMessages: 20,
  maxRecentToolMessages: 6,
  maxToolResultChars: 4_000,
  maxVisibleToolSchemas: 16,
  maxContextBlockChars: 4_000,
};

beforeEach(() => {
  initDefaultRuntimeBudgets(TEST_DEFAULTS);
});

afterEach(() => {
  // Restore defaults after each test so mutation doesn't bleed across tests
  initDefaultRuntimeBudgets(TEST_DEFAULTS);
});

describe('initDefaultRuntimeBudgets', () => {
  it('overrides individual budget fields with provided values', () => {
    initDefaultRuntimeBudgets({ maxHistoryMessages: 40, maxToolResultChars: 8_000 });

    expect(DEFAULT_RUNTIME_BUDGETS.maxHistoryMessages).toBe(40);
    expect(DEFAULT_RUNTIME_BUDGETS.maxToolResultChars).toBe(8_000);
  });

  it('leaves unspecified fields unchanged', () => {
    const originalRecentTools = DEFAULT_RUNTIME_BUDGETS.maxRecentToolMessages;
    const originalSchemas = DEFAULT_RUNTIME_BUDGETS.maxVisibleToolSchemas;

    initDefaultRuntimeBudgets({ maxHistoryMessages: 30 });

    expect(DEFAULT_RUNTIME_BUDGETS.maxRecentToolMessages).toBe(originalRecentTools);
    expect(DEFAULT_RUNTIME_BUDGETS.maxVisibleToolSchemas).toBe(originalSchemas);
  });

  it('overrides all five budget fields', () => {
    initDefaultRuntimeBudgets({
      maxHistoryMessages: 10,
      maxRecentToolMessages: 3,
      maxToolResultChars: 2_000,
      maxVisibleToolSchemas: 8,
      maxContextBlockChars: 2_000,
    });

    expect(DEFAULT_RUNTIME_BUDGETS.maxHistoryMessages).toBe(10);
    expect(DEFAULT_RUNTIME_BUDGETS.maxRecentToolMessages).toBe(3);
    expect(DEFAULT_RUNTIME_BUDGETS.maxToolResultChars).toBe(2_000);
    expect(DEFAULT_RUNTIME_BUDGETS.maxVisibleToolSchemas).toBe(8);
    expect(DEFAULT_RUNTIME_BUDGETS.maxContextBlockChars).toBe(2_000);
  });

  it('ignores null and undefined override values (does not zero out fields)', () => {
    const original = DEFAULT_RUNTIME_BUDGETS.maxHistoryMessages;

    // null — should be ignored
    initDefaultRuntimeBudgets({ maxHistoryMessages: undefined });

    expect(DEFAULT_RUNTIME_BUDGETS.maxHistoryMessages).toBe(original);
  });

  it('is idempotent: calling twice with the same values produces the same result', () => {
    initDefaultRuntimeBudgets({ maxHistoryMessages: 50 });
    initDefaultRuntimeBudgets({ maxHistoryMessages: 50 });

    expect(DEFAULT_RUNTIME_BUDGETS.maxHistoryMessages).toBe(50);
  });

  it('second call overwrites the first call', () => {
    initDefaultRuntimeBudgets({ maxHistoryMessages: 50 });
    initDefaultRuntimeBudgets({ maxHistoryMessages: 25 });

    expect(DEFAULT_RUNTIME_BUDGETS.maxHistoryMessages).toBe(25);
  });

  it('does nothing when called with an empty object', () => {
    const snapshot = { ...DEFAULT_RUNTIME_BUDGETS };

    initDefaultRuntimeBudgets({});

    expect(DEFAULT_RUNTIME_BUDGETS).toEqual(snapshot);
  });
});

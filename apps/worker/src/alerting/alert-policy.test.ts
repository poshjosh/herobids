import { describe, it, expect } from 'vitest';
import { classifySeverity, evaluateAlertPolicy } from './alert-policy.js';
import type { JournalEventRow } from './alert-policy.js';
import type { AlertsConfig } from '@herobids/domain';

function makeEvent(overrides: Partial<JournalEventRow> = {}): JournalEventRow {
  return {
    id: 'evt-1',
    botId: 'inst-1',
    type: 'execution.failure',
    payload: { message: 'timed out' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AlertsConfig> = {}): AlertsConfig {
  return {
    enabled: true,
    dispatchIntervalMs: 10_000,
    defaultCooldownMs: 300_000,
    maxBatchSize: 20,
    maxRetries: 3,
    telegram: {
      botToken: 'test-token',
      channels: [
        { chatId: '123', eventPrefixes: ['execution.', 'risk.'], minSeverity: 'warn' },
        { chatId: '456', eventPrefixes: ['instance.'], minSeverity: 'info' },
      ],
    },
    ...overrides,
  };
}

describe('classifySeverity', () => {
  it('returns critical for execution.failure', () => {
    expect(classifySeverity('execution.failure')).toBe('critical');
  });

  it('returns critical for risk.* prefix', () => {
    expect(classifySeverity('risk.exceeded')).toBe('critical');
  });

  it('returns warn for stream.disconnect', () => {
    expect(classifySeverity('stream.disconnect')).toBe('warn');
  });

  it('returns info for unknown types', () => {
    expect(classifySeverity('some.unknown.type')).toBe('info');
  });

  it('returns info for reconciliation.observed_variance', () => {
    expect(classifySeverity('reconciliation.observed_variance')).toBe('info');
  });
});

describe('evaluateAlertPolicy', () => {
  it('returns empty when alerting is disabled', () => {
    const config = makeConfig({ enabled: false });
    const result = evaluateAlertPolicy([makeEvent()], config);
    expect(result).toEqual([]);
  });

  it('returns empty when no channels configured', () => {
    const config = makeConfig({ telegram: { botToken: 'x', channels: [] } });
    const result = evaluateAlertPolicy([makeEvent()], config);
    expect(result).toEqual([]);
  });

  it('routes execution.failure to channel matching execution. prefix with minSeverity warn', () => {
    const config = makeConfig();
    const event = makeEvent({ type: 'execution.failure' });
    const result = evaluateAlertPolicy([event], config);
    expect(result).toHaveLength(1);
    expect(result[0]!.destinations).toEqual([{ channel: 'telegram', chatId: '123' }]);
  });

  it('does not route info events to channels with minSeverity warn', () => {
    const config = makeConfig();
    const event = makeEvent({ type: 'execution.completed' }); // no mapping → info
    const result = evaluateAlertPolicy([event], config);
    // execution. prefix matches channel 123, but severity info < warn threshold
    expect(result).toHaveLength(0);
  });

  it('routes instance.crashed to channel matching instance. prefix', () => {
    const config = makeConfig();
    const event = makeEvent({ type: 'instance.crashed' });
    const result = evaluateAlertPolicy([event], config);
    expect(result).toHaveLength(1);
    expect(result[0]!.destinations).toEqual([{ channel: 'telegram', chatId: '456' }]);
  });

  it('does not route observed variance to warn-only reconciliation channels', () => {
    const config = makeConfig({
      telegram: {
        botToken: 'x',
        channels: [
          { chatId: '789', eventPrefixes: ['reconciliation.'], minSeverity: 'warn' },
        ],
      },
    });
    const event = makeEvent({ type: 'reconciliation.observed_variance' });
    const result = evaluateAlertPolicy([event], config);
    expect(result).toHaveLength(0);
  });

  it('routes to multiple channels when prefixes and severity both match', () => {
    const config = makeConfig({
      telegram: {
        botToken: 'x',
        channels: [
          { chatId: '100', eventPrefixes: ['risk.'], minSeverity: 'info' },
          { chatId: '200', eventPrefixes: ['risk.'], minSeverity: 'critical' },
        ],
      },
    });
    const event = makeEvent({ type: 'risk.exceeded' });
    const result = evaluateAlertPolicy([event], config);
    expect(result).toHaveLength(1);
    expect(result[0]!.destinations).toHaveLength(2);
  });
});

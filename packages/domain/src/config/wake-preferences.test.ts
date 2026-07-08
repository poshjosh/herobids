import { describe, it, expect } from 'vitest';
import { WakePreferencesSchema } from './schema.js';

describe('WakePreferencesSchema', () => {
  it('accepts valid subscribedSources', () => {
    const result = WakePreferencesSchema.parse({ subscribedSources: ['watch_threshold', 'discovery_delta'] });
    expect(result.subscribedSources).toEqual(['watch_threshold', 'discovery_delta']);
  });

  it('defaults subscribedSources to undefined when absent', () => {
    const result = WakePreferencesSchema.parse({});
    expect(result.subscribedSources).toBeUndefined();
  });

  it('deduplicates subscribedSources', () => {
    const result = WakePreferencesSchema.parse({ subscribedSources: ['watch_threshold', 'watch_threshold', 'discovery_delta'] });
    expect(result.subscribedSources).toEqual(['watch_threshold', 'discovery_delta']);
  });

  it('rejects empty subscribedSources array', () => {
    expect(() => WakePreferencesSchema.parse({ subscribedSources: [] })).toThrow();
  });

  it('rejects invalid source names', () => {
    expect(() => WakePreferencesSchema.parse({ subscribedSources: ['invalid_source'] })).toThrow();
  });
});

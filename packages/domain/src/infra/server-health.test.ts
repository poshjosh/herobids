import { describe, it, expect } from 'vitest';
import {
  SERVER_TYPES,
  serverHealthKey,
  serverHealthKeyPattern,
  SERVER_HEALTH_TTL_SECONDS,
  SERVER_HEALTH_PUBLISH_INTERVAL_MS,
} from './server-health.js';

describe('server-health constants and helpers', () => {
  describe('SERVER_TYPES', () => {
    it('contains the expected four server types', () => {
      expect(SERVER_TYPES).toEqual(['control-plane', 'agent-server', 'browser-pool', 'trading']);
    });

    it('has exactly four entries', () => {
      expect(SERVER_TYPES).toHaveLength(4);
    });
  });

  describe('serverHealthKey', () => {
    it('returns the correct Redis key for control-plane', () => {
      expect(serverHealthKey('control-plane', 'srv-1')).toBe(
        'herobids:server-health:control-plane:srv-1',
      );
    });

    it('returns the correct Redis key for agent-server', () => {
      expect(serverHealthKey('agent-server', 'agent-abc')).toBe(
        'herobids:server-health:agent-server:agent-abc',
      );
    });

    it('returns the correct Redis key for browser-pool', () => {
      expect(serverHealthKey('browser-pool', 'bp-42')).toBe(
        'herobids:server-health:browser-pool:bp-42',
      );
    });

    it('returns the correct Redis key for trading', () => {
      expect(serverHealthKey('trading', 'trade-007')).toBe(
        'herobids:server-health:trading:trade-007',
      );
    });

    it('handles server IDs with special characters', () => {
      expect(serverHealthKey('control-plane', 'host.example.com')).toBe(
        'herobids:server-health:control-plane:host.example.com',
      );
    });
  });

  describe('serverHealthKeyPattern', () => {
    it('returns the wildcard SCAN pattern', () => {
      expect(serverHealthKeyPattern()).toBe('herobids:server-health:*');
    });
  });

  describe('SERVER_HEALTH_TTL_SECONDS', () => {
    it('is 60 seconds', () => {
      expect(SERVER_HEALTH_TTL_SECONDS).toBe(60);
    });
  });

  describe('SERVER_HEALTH_PUBLISH_INTERVAL_MS', () => {
    it('is 15000 milliseconds', () => {
      expect(SERVER_HEALTH_PUBLISH_INTERVAL_MS).toBe(15_000);
    });
  });
});

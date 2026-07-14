/**
 * Unit tests for Telegram command handler pure functions and helpers.
 *
 * Tests pure/stateless functions that do not require a database connection.
 * DB-dependent functions (resolveAgentByName, resolveConnectionByIdOrLabel)
 * are tested in the functional test suite.
 */

import { describe, expect, it } from 'vitest';
import {
  formatActivityLabel,
  truncateForTelegram,
} from './telegram-command-handlers.js';

// ─── formatActivityLabel ─────────────────────────────────────────────────

describe('formatActivityLabel', () => {
  it('maps agent.decision types to DECISION', () => {
    expect(formatActivityLabel('agent.decision.go_long')).toBe('DECISION');
    expect(formatActivityLabel('agent.decision.go_flat')).toBe('DECISION');
    expect(formatActivityLabel('agent.decision')).toBe('DECISION');
  });

  it('maps user types to USER', () => {
    expect(formatActivityLabel('user.message')).toBe('USER');
    expect(formatActivityLabel('user.command')).toBe('USER');
    expect(formatActivityLabel('user')).toBe('USER');
  });

  it('maps system types to SYSTEM', () => {
    expect(formatActivityLabel('system.heartbeat')).toBe('SYSTEM');
    expect(formatActivityLabel('system.market_snapshot')).toBe('SYSTEM');
    expect(formatActivityLabel('system')).toBe('SYSTEM');
  });

  it('maps agent.message types to AGENT', () => {
    expect(formatActivityLabel('agent.message.chat')).toBe('AGENT');
    expect(formatActivityLabel('agent.message')).toBe('AGENT');
  });

  it('falls back to last segment for unknown types', () => {
    expect(formatActivityLabel('custom.event')).toBe('EVENT');
    expect(formatActivityLabel('venue.trade')).toBe('TRADE');
    expect(formatActivityLabel('unknown')).toBe('UNKNOWN');
  });

  it('handles empty string gracefully', () => {
    expect(formatActivityLabel('')).toBe('');
  });
});

// ─── truncateForTelegram ─────────────────────────────────────────────────

describe('truncateForTelegram', () => {
  it('returns text unchanged when under maxChars', () => {
    const text = 'short message';
    expect(truncateForTelegram(text)).toBe(text);
    expect(truncateForTelegram(text, 100)).toBe(text);
  });

  it('returns text unchanged when exactly at maxChars', () => {
    const text = 'a'.repeat(3800);
    expect(truncateForTelegram(text)).toBe(text);
  });

  it('truncates at the last newline before maxChars', () => {
    // Create 10 lines each ~7 characters: "Line 1", "Line 2", etc.
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join('\n');
    // With maxChars = 25, we'll truncate somewhere mid-content
    const result = truncateForTelegram(lines, 25);
    expect(result).toContain('...and');
    // Result should be shorter than the original
    expect(result.length).toBeLessThan(lines.length);
  });

  it('appends "...and more" when no newline found before maxChars', () => {
    const text = 'a'.repeat(100);
    const result = truncateForTelegram(text, 50);
    expect(result).toContain('...and more');
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('counts remaining non-empty items correctly', () => {
    const lines = ['one', 'two', '', 'three', 'four', 'five'].join('\n');
    const result = truncateForTelegram(lines, 20);
    // Should have truncated after ~first 3 items, counting 3 remaining
    expect(result).toMatch(/\.\.\.and \d+ more/);
  });

  it('handles empty text', () => {
    expect(truncateForTelegram('')).toBe('');
    expect(truncateForTelegram('', 10)).toBe('');
  });
});

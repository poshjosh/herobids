import { describe, expect, it } from 'vitest';
import { deriveCapabilityMode } from './derive-capability-mode.js';

describe('deriveCapabilityMode', () => {
  it('returns both when trading skill and goal are present', () => {
    expect(deriveCapabilityMode(['trading'], 'Trade BTC')).toBe('both');
  });

  it('returns both when bot-management skill and goal are present', () => {
    expect(deriveCapabilityMode(['bot-management'], 'Manage my portfolio')).toBe('both');
  });

  it('returns both when both trading and bot-management skills with goal are present', () => {
    expect(deriveCapabilityMode(['trading', 'bot-management'], 'Trade BTC')).toBe('both');
  });

  it('returns intelligence when goal is present but no trading skills', () => {
    expect(deriveCapabilityMode(['web-access'], 'Research markets')).toBe('intelligence');
  });

  it('returns intelligence when goal is present with empty skill list', () => {
    expect(deriveCapabilityMode([], 'Analyze trends')).toBe('intelligence');
  });

  it('returns technical when no goal and no trading skills', () => {
    expect(deriveCapabilityMode(['web-access'], '')).toBe('technical');
  });

  it('returns technical when no goal and empty skill list', () => {
    expect(deriveCapabilityMode([], '')).toBe('technical');
  });

  it('returns technical when only trading skill but no goal', () => {
    expect(deriveCapabilityMode(['trading'], '')).toBe('technical');
  });

  it('treats whitespace-only goal as no goal', () => {
    expect(deriveCapabilityMode(['trading'], '   ')).toBe('technical');
  });
});

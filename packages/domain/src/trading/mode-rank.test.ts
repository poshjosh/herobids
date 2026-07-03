import { describe, it, expect } from 'vitest';
import { checkModeEscalation } from './mode-rank.js';

describe('checkModeEscalation', () => {
  // ── Same-rank ──────────────────────────────────────────────────────────

  it('allows same-rank (paper agent, paper bot)', () => {
    const result = checkModeEscalation('paper', 'paper');
    expect(result.allowed).toBe(true);
  });

  it('allows same-rank (shadow agent, shadow bot)', () => {
    const result = checkModeEscalation('shadow', 'shadow');
    expect(result.allowed).toBe(true);
  });

  it('allows same-rank (live agent, live bot)', () => {
    const result = checkModeEscalation('live', 'live');
    expect(result.allowed).toBe(true);
  });

  // ── Downgrade ──────────────────────────────────────────────────────────

  it('allows downgrade (shadow agent → paper bot)', () => {
    const result = checkModeEscalation('paper', 'shadow');
    expect(result.allowed).toBe(true);
  });

  it('allows downgrade (live agent → shadow bot)', () => {
    const result = checkModeEscalation('shadow', 'live');
    expect(result.allowed).toBe(true);
  });

  it('allows downgrade (live agent → paper bot)', () => {
    const result = checkModeEscalation('paper', 'live');
    expect(result.allowed).toBe(true);
  });

  // ── Escalation rejection ───────────────────────────────────────────────

  it('rejects paper agent → shadow bot with correct permitted list', () => {
    const result = checkModeEscalation('shadow', 'paper');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error).toContain('Cannot adjust a bot to execution mode "shadow"');
      // Permitted list should only contain 'paper', not 'shadow' or 'live'
      const permittedMatch = result.error.match(/Permitted execution modes: (.+)\./);
      expect(permittedMatch).not.toBeNull();
      const permitted = permittedMatch![1]!.split(', ').map(s => s.trim());
      expect(permitted).toContain('paper');
      expect(permitted).not.toContain('shadow');
      expect(permitted).not.toContain('live');
    }
  });

  it('rejects paper agent → live bot with correct permitted list', () => {
    const result = checkModeEscalation('live', 'paper');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error).toContain('Cannot adjust a bot to execution mode "live"');
      // Permitted list should only contain 'paper'
      const permittedMatch = result.error.match(/Permitted execution modes: (.+)\./);
      expect(permittedMatch).not.toBeNull();
      const permitted = permittedMatch![1]!.split(', ').map(s => s.trim());
      expect(permitted).toContain('paper');
      expect(permitted).not.toContain('shadow');
      expect(permitted).not.toContain('live');
    }
  });

  it('rejects shadow agent → live bot with correct permitted list', () => {
    const result = checkModeEscalation('live', 'shadow');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error).toContain('Cannot adjust a bot to execution mode "live"');
      // Permitted list should contain 'paper' and 'shadow', not 'live'
      const permittedMatch = result.error.match(/Permitted execution modes: (.+)\./);
      expect(permittedMatch).not.toBeNull();
      const permitted = permittedMatch![1]!.split(', ').map(s => s.trim());
      expect(permitted).toContain('paper');
      expect(permitted).toContain('shadow');
      expect(permitted).not.toContain('live');
    }
  });

  // ── Context verb ───────────────────────────────────────────────────────

  it('uses "create a bot with" when context is create', () => {
    const result = checkModeEscalation('live', 'paper', 'create');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error).toContain('create a bot with');
      expect(result.error).not.toContain('adjust a bot to');
    }
  });

  it('uses "adjust a bot to" when context is adjust (default)', () => {
    const result = checkModeEscalation('live', 'paper');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error).toContain('adjust a bot to');
      expect(result.error).not.toContain('create a bot with');
    }
  });

  // ── Unknown modes ──────────────────────────────────────────────────────

  it('defaults unknown agent mode to paper rank (0)', () => {
    const result = checkModeEscalation('shadow', 'unknown');
    // unknown agent mode → rank 0, so shadow (rank 1) would be an escalation
    expect(result.allowed).toBe(false);
  });

  it('defaults unknown requested mode to paper rank (0)', () => {
    const result = checkModeEscalation('unknown', 'live');
    // unknown requested mode → rank 0, live agent can allow rank 0
    expect(result.allowed).toBe(true);
  });
});

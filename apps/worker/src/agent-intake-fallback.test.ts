import { describe, expect, it } from 'vitest';
import {
  canUseAgentGrantFallback,
  isCurrentAgentGrantFallbackSession,
  setAgentGrantFallbackAllowed,
  shouldUseAgentGrantFallback,
  startAgentGrantFallbackSession,
} from './agent-intake-fallback.js';

describe('shouldUseAgentGrantFallback', () => {
  it('allows fallback for paper orderbook sessions', () => {
    expect(shouldUseAgentGrantFallback('paper', 'orderbook')).toBe(true);
  });

  it('blocks fallback for shadow execution mode', () => {
    expect(shouldUseAgentGrantFallback('shadow', 'orderbook')).toBe(false);
  });

  it('blocks fallback for live execution mode', () => {
    expect(shouldUseAgentGrantFallback('live', 'orderbook')).toBe(false);
  });

  it('blocks fallback for swap sessions even in paper mode', () => {
    expect(shouldUseAgentGrantFallback('paper', 'swap')).toBe(false);
  });

  it('blocks fallback when execution mode is unknown', () => {
    expect(shouldUseAgentGrantFallback(undefined, 'orderbook')).toBe(false);
  });

  it('does not let an older session re-enable fallback after a newer session takes ownership', () => {
    let state = startAgentGrantFallbackSession('sess-1');
    state = startAgentGrantFallbackSession('sess-2');

    expect(isCurrentAgentGrantFallbackSession(state, 'sess-1')).toBe(false);
    expect(isCurrentAgentGrantFallbackSession(state, 'sess-2')).toBe(true);

    // Older session must not be able to re-enable fallback once ownership changed.
    if (isCurrentAgentGrantFallbackSession(state, 'sess-1')) {
      state = setAgentGrantFallbackAllowed('sess-1', true);
    }

    expect(canUseAgentGrantFallback(state)).toBe(false);

    if (isCurrentAgentGrantFallbackSession(state, 'sess-2')) {
      state = setAgentGrantFallbackAllowed('sess-2', true);
    }

    expect(canUseAgentGrantFallback(state)).toBe(true);
  });

  it('fallback stays disabled during actor startup window until explicitly enabled', () => {
    // Simulates the worker flow: startAgentGrantFallbackSession is called first,
    // then the actor starts asynchronously. Until setAgentGrantFallbackAllowed is
    // called AFTER registration, fallback must remain disabled so decisions get
    // rejected as instance_not_running rather than routing through permissive limits.
    const state = startAgentGrantFallbackSession('sess-startup');

    // During the entire startup window, canUseAgentGrantFallback must be false
    expect(canUseAgentGrantFallback(state)).toBe(false);

    // Only after actor registration would the worker call setAgentGrantFallbackAllowed
    const afterRegistration = setAgentGrantFallbackAllowed('sess-startup', true);
    expect(canUseAgentGrantFallback(afterRegistration)).toBe(true);
  });
});
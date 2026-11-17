import { describe, expect, it } from 'vitest';
import { resolveJudgeMaxTokens } from './judge-max-tokens.js';

describe('resolveJudgeMaxTokens', () => {
  it('uses the agent policy limit when the agent has a resolved policy', () => {
    expect(resolveJudgeMaxTokens(4096, { judgeMaxTokens: 8192 })).toBe(8192);
  });

  it('can be lower than the operator default, because the agent policy wins', () => {
    expect(resolveJudgeMaxTokens(8192, { judgeMaxTokens: 4096 })).toBe(4096);
  });

  it('falls back to the operator default when the agent has no resolved policy', () => {
    expect(resolveJudgeMaxTokens(4096, undefined)).toBe(4096);
  });
});

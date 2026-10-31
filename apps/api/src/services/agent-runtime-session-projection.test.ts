import { describe, it, expect } from 'vitest';
import { agentRuntimeSessionPublicColumns } from './agent-runtime-session-projection.js';

describe('agentRuntimeSessionPublicColumns', () => {
  it('excludes the API key hash', () => {
    expect(agentRuntimeSessionPublicColumns).not.toHaveProperty('apiKeyHash');
  });

  it('excludes startup facts and placement allocation identity', () => {
    expect(agentRuntimeSessionPublicColumns).not.toHaveProperty('runtimeRegisteredAt');
    expect(agentRuntimeSessionPublicColumns).not.toHaveProperty('firstPlacedAt');
    expect(agentRuntimeSessionPublicColumns).not.toHaveProperty('placementAllocationId');
  });

  it('still exposes the core session columns', () => {
    expect(agentRuntimeSessionPublicColumns).toHaveProperty('id');
    expect(agentRuntimeSessionPublicColumns).toHaveProperty('status');
    expect(agentRuntimeSessionPublicColumns).toHaveProperty('startedAt');
  });
});

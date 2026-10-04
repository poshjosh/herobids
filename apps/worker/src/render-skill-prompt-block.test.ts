// Phase 4 T7 — progressive-disclosure rendering of a skill's prompt block.
import { describe, it, expect } from 'vitest';
import type { SkillDefinition } from '@herobids/domain';
import { renderSkillPromptBlock, type ExternalSkillSessionState } from './runtime-composition.js';

function skill(partial: Partial<SkillDefinition>): SkillDefinition {
  return {
    id: 'x',
    name: 'X',
    description: 'desc',
    instructions: 'FULL INSTRUCTIONS',
    requiredTools: [],
    capabilityFamilies: [],
    bindingRequirements: {},
    contextRequirements: [],
    requiredContextBlocks: [],
    promptRendererHints: [],
    requiredGuardrails: [],
    suggestedTickIntervalMs: 900_000,
    visibility: 'public',
    ...partial,
  };
}

function emptySession(): ExternalSkillSessionState {
  return { availability: new Map(), loadedBodies: new Map() };
}

describe('renderSkillPromptBlock', () => {
  it('renders a system skill with its full instructions, unchanged', () => {
    const block = renderSkillPromptBlock(skill({ name: 'Programming', instructions: 'FULL INSTRUCTIONS' }), emptySession());
    expect(block).toBe('## Skill: Programming\n\nFULL INSTRUCTIONS');
  });

  it('lists an unloaded external skill by name + description + read_skill hint, NOT its body', () => {
    const ref = 'traderton/skills/crypto-trading';
    const block = renderSkillPromptBlock(
      skill({ name: 'Crypto Trading', description: 'trade crypto', instructions: '', sourceRef: ref }),
      emptySession(),
    );
    expect(block).toContain('## Skill: Crypto Trading');
    expect(block).toContain('trade crypto');
    expect(block).toContain('read_skill');
    expect(block).toContain(ref);
    expect(block).not.toContain('FULL INSTRUCTIONS');
  });

  it('injects the loaded body for an external skill once loaded this session', () => {
    const ref = 'traderton/skills/crypto-trading';
    const session = emptySession();
    session.loadedBodies.set(ref, 'LOADED BODY TEXT');
    const block = renderSkillPromptBlock(
      skill({ name: 'Crypto Trading', description: 'trade crypto', instructions: '', sourceRef: ref }),
      session,
    );
    expect(block).toContain('LOADED BODY TEXT');
    expect(block).not.toContain('read_skill');
  });

  it('marks an external skill temporarily unavailable when this session install failed', () => {
    const ref = 'traderton/skills/crypto-trading';
    const session = emptySession();
    session.availability.set(ref, { available: false, name: 'Crypto Trading', description: 'trade crypto', unavailableReason: 'github down' });
    const block = renderSkillPromptBlock(
      skill({ name: 'Crypto Trading', description: 'trade crypto', instructions: '', sourceRef: ref }),
      session,
    );
    expect(block).toContain('temporarily unavailable');
  });
});

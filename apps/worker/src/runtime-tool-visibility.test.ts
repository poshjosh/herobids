import { describe, it, expect } from 'vitest';
import type { RuntimeDescriptor } from '@herobids/domain';
import {
  createRuntimeToolVisibilityController,
  DATABASE_DEPENDENT_TOOLS,
  MARKET_DATA_TOOLS,
} from './runtime-tool-visibility.js';

function makeDescriptor(skills: Array<{ id: string; tools: string[] }>): RuntimeDescriptor {
  return {
    schemaVersion: 'v1',
    agentId: 'test-agent',
    goal: 'test',
    executionMode: 'paper',
    resolvedSkills: skills.map(({ id, tools }) => ({
      id,
      name: id,
      description: '',
      requiredTools: tools,
      isOptional: false,
      prompt: '',
    })),
    grantedBindingsByFamily: {},
    defaultBindingByFamily: {},
    readinessByFamily: {},
    toolPolicy: {},
    guardrails: {},
    budgets: {
      maxHistoryMessages: 20,
      maxRecentToolMessages: 6,
      maxToolResultChars: 4_000,
      maxVisibleToolSchemas: 100,
      maxContextBlockChars: 4_000,
    },
  };
}

describe('createRuntimeToolVisibilityController', () => {
  it('exposes all skill tools when no exclusions are set', () => {
    const descriptor = makeDescriptor([{ id: 'trade', tools: ['list_bots', 'send_message'] }]);
    const controller = createRuntimeToolVisibilityController(() => descriptor, new Set());

    expect(controller.allowedTools()).toContain('list_bots');
    expect(controller.allowedTools()).toContain('send_message');
  });

  it('excludes permanently excluded tools from the start', () => {
    const descriptor = makeDescriptor([{ id: 'trade', tools: ['list_bots', 'send_message'] }]);
    const permanent = new Set(['list_bots']);
    const controller = createRuntimeToolVisibilityController(() => descriptor, permanent);

    expect(descriptor.resolvedSkills[0]!.requiredTools).not.toContain('list_bots');
    expect(descriptor.resolvedSkills[0]!.requiredTools).toContain('send_message');
  });

  it('removes database-dependent tools when database becomes unavailable', () => {
    const dbTools = [...DATABASE_DEPENDENT_TOOLS];
    const descriptor = makeDescriptor([{ id: 'trade', tools: [...dbTools, 'send_message'] }]);
    const controller = createRuntimeToolVisibilityController(() => descriptor, new Set());

    controller.setDependencyAvailability('database', false);

    const visibleTools = descriptor.resolvedSkills[0]!.requiredTools;
    for (const tool of dbTools) {
      expect(visibleTools).not.toContain(tool);
    }
    expect(visibleTools).toContain('send_message');
  });

  it('restores database-dependent tools when database comes back online', () => {
    const dbTools = [...DATABASE_DEPENDENT_TOOLS];
    const descriptor = makeDescriptor([{ id: 'trade', tools: [...dbTools, 'send_message'] }]);
    const controller = createRuntimeToolVisibilityController(() => descriptor, new Set());

    controller.setDependencyAvailability('database', false);
    controller.setDependencyAvailability('database', true);

    const visibleTools = descriptor.resolvedSkills[0]!.requiredTools;
    for (const tool of dbTools) {
      expect(visibleTools).toContain(tool);
    }
  });

  it('removes market-data tools when market-data becomes unavailable', () => {
    const mdTools = [...MARKET_DATA_TOOLS];
    const descriptor = makeDescriptor([{ id: 'web-access', tools: [...mdTools, 'send_message'] }]);
    const controller = createRuntimeToolVisibilityController(() => descriptor, new Set());

    controller.setDependencyAvailability('market-data', false);

    const visibleTools = descriptor.resolvedSkills[0]!.requiredTools;
    for (const tool of mdTools) {
      expect(visibleTools).not.toContain(tool);
    }
    expect(visibleTools).toContain('send_message');
  });

  it('tracks degraded dependencies and excluded tools', () => {
    const descriptor = makeDescriptor([
      { id: 'trade', tools: ['list_bots', 'search_tokens', 'send_message'] },
    ]);
    const controller = createRuntimeToolVisibilityController(() => descriptor, new Set());

    controller.setDependencyAvailability('database', false);

    expect(controller.getDependencyDegradations()).toContain('database');
    expect(controller.getDegradedExcludedTools()).toContain('list_bots');
    expect(controller.getDependencyDegradations()).not.toContain('market-data');
  });

  it('can degrade and restore an individual tool', () => {
    const descriptor = makeDescriptor([{ id: 'code', tools: ['execute_code', 'send_message'] }]);
    const controller = createRuntimeToolVisibilityController(() => descriptor, new Set());

    controller.setToolAvailability('execute_code', false);
    expect(descriptor.resolvedSkills[0]!.requiredTools).not.toContain('execute_code');
    expect(controller.getDegradedExcludedTools()).toContain('execute_code');

    controller.setToolAvailability('execute_code', true);
    expect(descriptor.resolvedSkills[0]!.requiredTools).toContain('execute_code');
    expect(controller.getDegradedExcludedTools()).not.toContain('execute_code');
  });

  it('preserves tool-level degradations across snapshotToolBaselines on the same descriptor', () => {
    const descriptor = makeDescriptor([{ id: 'code', tools: ['execute_code', 'send_message'] }]);
    const controller = createRuntimeToolVisibilityController(() => descriptor, new Set());

    controller.setToolAvailability('execute_code', false);
    controller.snapshotToolBaselines();
    controller.setToolAvailability('execute_code', true);

    expect(descriptor.resolvedSkills[0]!.requiredTools).toContain('execute_code');
  });

  it('clears dependency from degraded set when restored', () => {
    const descriptor = makeDescriptor([{ id: 'trade', tools: ['list_bots'] }]);
    const controller = createRuntimeToolVisibilityController(() => descriptor, new Set());

    controller.setDependencyAvailability('database', false);
    expect(controller.getDependencyDegradations()).toContain('database');

    controller.setDependencyAvailability('database', true);
    expect(controller.getDependencyDegradations()).not.toContain('database');
    expect(controller.getDegradedExcludedTools()).not.toContain('list_bots');
  });

  it('excludes circuit-blocked tools when applyToolVisibility is called with them', () => {
    const descriptor = makeDescriptor([
      { id: 'trade', tools: ['list_bots', 'send_message', 'get_bot_status'] },
    ]);
    const controller = createRuntimeToolVisibilityController(() => descriptor, new Set());

    const circuitBlocked = new Set(['get_bot_status']);
    controller.applyToolVisibility(circuitBlocked);

    const visibleTools = descriptor.resolvedSkills[0]!.requiredTools;
    expect(visibleTools).not.toContain('get_bot_status');
    expect(visibleTools).toContain('list_bots');
    expect(visibleTools).toContain('send_message');
  });

  it('snapshotToolBaselines preserves original tool list for reapplication', () => {
    const descriptor = makeDescriptor([
      { id: 'trade', tools: ['list_bots', 'send_message'] },
    ]);
    const controller = createRuntimeToolVisibilityController(() => descriptor, new Set());

    // Degrade once to alter skill.requiredTools
    controller.setDependencyAvailability('database', false);
    expect(descriptor.resolvedSkills[0]!.requiredTools).not.toContain('list_bots');

    // Restore — snapshot should bring back the full list
    controller.setDependencyAvailability('database', true);
    expect(descriptor.resolvedSkills[0]!.requiredTools).toContain('list_bots');
  });

  it('combined permanent + degraded exclusions both apply simultaneously', () => {
    const descriptor = makeDescriptor([
      {
        id: 'trade',
        tools: ['list_bots', 'search_tokens', 'send_message'],
      },
    ]);
    const permanent = new Set(['search_tokens']);
    const controller = createRuntimeToolVisibilityController(() => descriptor, permanent);

    controller.setDependencyAvailability('database', false);

    const visibleTools = descriptor.resolvedSkills[0]!.requiredTools;
    expect(visibleTools).not.toContain('list_bots');     // degraded
    expect(visibleTools).not.toContain('search_tokens'); // permanent
    expect(visibleTools).toContain('send_message');      // untouched
  });

  // Regression: after agent.runtime.config_update replaces state.runtimeDescriptor,
  // the controller must continue applying degradations and exclusions to the new
  // descriptor rather than silently reverting to the stale one.
  it('continues applying degradations to the replacement descriptor after snapshotToolBaselines is called', () => {
    const descriptorV1 = makeDescriptor([{ id: 'trade', tools: ['list_bots', 'send_message'] }]);
    let currentDescriptor = descriptorV1;
    const controller = createRuntimeToolVisibilityController(() => currentDescriptor, new Set());

    // Degrade the database dependency on v1.
    controller.setDependencyAvailability('database', false);
    expect(descriptorV1.resolvedSkills[0]!.requiredTools).not.toContain('list_bots');

    // Simulate a config_update: swap in a new descriptor with the same tools and re-snapshot.
    const descriptorV2 = makeDescriptor([{ id: 'trade', tools: ['list_bots', 'send_message'] }]);
    currentDescriptor = descriptorV2;
    controller.snapshotToolBaselines();
    controller.applyToolVisibility();

    // The existing degradation must carry over — list_bots should still be hidden on v2.
    expect(descriptorV2.resolvedSkills[0]!.requiredTools).not.toContain('list_bots');
    expect(descriptorV2.resolvedSkills[0]!.requiredTools).toContain('send_message');

    // v1 must not be mutated by subsequent operations.
    controller.setDependencyAvailability('database', true);
    expect(descriptorV2.resolvedSkills[0]!.requiredTools).toContain('list_bots');
    // v1 should not have been re-touched.
    expect(descriptorV1.resolvedSkills[0]!.requiredTools).not.toContain('list_bots');
  });

  it('hides watch_token and check_watches but keeps list_watches and remove_watch when market-data is unavailable', () => {
    const watchTools = ['watch_token', 'list_watches', 'remove_watch', 'check_watches', 'send_message'];
    const descriptor = makeDescriptor([{ id: 'monitoring', tools: watchTools }]);
    const controller = createRuntimeToolVisibilityController(() => descriptor, new Set());

    controller.setDependencyAvailability('market-data', false);

    const visibleTools = descriptor.resolvedSkills[0]!.requiredTools;
    expect(visibleTools).not.toContain('watch_token');
    expect(visibleTools).not.toContain('check_watches');
    // list_watches and remove_watch only need Redis — still available during market-data outage
    expect(visibleTools).toContain('list_watches');
    expect(visibleTools).toContain('remove_watch');
    expect(visibleTools).toContain('send_message');
  });
});

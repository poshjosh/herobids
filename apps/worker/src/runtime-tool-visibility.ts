import type { RuntimeDescriptor } from '@herobids/domain';
import { applyToolExclusions } from './runtime-resilience.js';

export type RuntimeDependency = 'database' | 'market-data';

export const DATABASE_DEPENDENT_TOOLS = new Set([
  'list_bots',
  'get_bot_status',
  'get_analytics',
  'list_positions',
  'stop_bot',
  'start_bot',
  'adjust_bot_config',
  'find_instrument',
  'get_account_summary',
  'resolve_bot',
  'list_skills',
  'add_skills',
  'remove_skills',
]);

export const MARKET_DATA_TOOLS = new Set([
  'check_regime',
  'search_tokens',
  'discover_tokens',
  'get_funding_rates',
  'get_market_overview',
  'get_price',
  'watch_token',
  'check_watches',
]);

function dependencyTools(dependency: RuntimeDependency): Set<string> {
  return dependency === 'database' ? DATABASE_DEPENDENT_TOOLS : MARKET_DATA_TOOLS;
}

function getVisibleToolNames(runtimeDescriptor: RuntimeDescriptor): string[] {
  const tools = new Set<string>();
  for (const skill of runtimeDescriptor.resolvedSkills) {
    for (const tool of skill.requiredTools) {
      tools.add(tool);
      if (tools.size >= runtimeDescriptor.budgets.maxVisibleToolSchemas) {
        return [...tools];
      }
    }
  }
  return [...tools];
}

export interface RuntimeToolVisibilityController {
  snapshotToolBaselines(): void;
  applyToolVisibility(circuitBlockedTools?: Set<string>): void;
  setDependencyAvailability(dependency: RuntimeDependency, available: boolean, circuitBlockedTools?: Set<string>): void;
  setToolAvailability(tool: string, available: boolean, circuitBlockedTools?: Set<string>): void;
  getDependencyDegradations(): Set<RuntimeDependency>;
  getDegradedExcludedTools(): Set<string>;
  allowedTools(): Set<string>;
}

export function createRuntimeToolVisibilityController(
  // Accept a getter so the controller always operates on the live descriptor,
  // even after agent.runtime.config_update replaces state.runtimeDescriptor.
  getDescriptor: () => RuntimeDescriptor,
  permanentlyExcludedTools: Set<string>,
): RuntimeToolVisibilityController {
  const baseRequiredToolsBySkill = new Map<string, string[]>();
  const degradedExcludedTools = new Set<string>();
  const dependencyDegradations = new Set<RuntimeDependency>();
  let lastSnapshotDescriptor: RuntimeDescriptor | null = null;

  function snapshotToolBaselines(): void {
    const runtimeDescriptor = getDescriptor();
    if (runtimeDescriptor === lastSnapshotDescriptor) {
      return;
    }
    baseRequiredToolsBySkill.clear();
    for (const skill of runtimeDescriptor.resolvedSkills) {
      baseRequiredToolsBySkill.set(skill.id, [...skill.requiredTools]);
    }
    lastSnapshotDescriptor = runtimeDescriptor;
  }

  function applyToolVisibility(circuitBlockedTools = new Set<string>()): void {
    const runtimeDescriptor = getDescriptor();
    for (const skill of runtimeDescriptor.resolvedSkills) {
      const baseline = baseRequiredToolsBySkill.get(skill.id) ?? [...skill.requiredTools];
      skill.requiredTools = applyToolExclusions(baseline, {
        permanent: permanentlyExcludedTools,
        degraded: degradedExcludedTools,
        circuit: circuitBlockedTools,
      });
    }
  }

  function setDependencyAvailability(
    dependency: RuntimeDependency,
    available: boolean,
    circuitBlockedTools = new Set<string>(),
  ): void {
    const tools = dependencyTools(dependency);
    if (available) {
      dependencyDegradations.delete(dependency);
      for (const tool of tools) {
        degradedExcludedTools.delete(tool);
      }
    } else {
      dependencyDegradations.add(dependency);
      for (const tool of tools) {
        degradedExcludedTools.add(tool);
      }
    }
    applyToolVisibility(circuitBlockedTools);
  }

  function setToolAvailability(tool: string, available: boolean, circuitBlockedTools = new Set<string>()): void {
    if (available) {
      degradedExcludedTools.delete(tool);
    } else {
      degradedExcludedTools.add(tool);
    }
    applyToolVisibility(circuitBlockedTools);
  }

  snapshotToolBaselines();
  applyToolVisibility();

  return {
    snapshotToolBaselines,
    applyToolVisibility,
    setDependencyAvailability,
    setToolAvailability,
    getDependencyDegradations: () => new Set(dependencyDegradations),
    getDegradedExcludedTools: () => new Set(degradedExcludedTools),
    allowedTools: () => new Set(getVisibleToolNames(getDescriptor())),
  };
}
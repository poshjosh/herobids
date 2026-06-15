import { BASE_SKILL, KNOWN_AGENT_TOOL_NAMES, SYSTEM_SKILLS, findUnknownSkillTools } from '@herobids/domain';
import { ToolRegistry } from './registry.js';
import { messagingTools } from './messaging.js';
import { memoryTools } from './memory.js';
import { tradingTools } from './trading.js';
import { botManagementTools } from './bots.js';
import { analyticsTools } from './analytics.js';
import { codeTools } from './code.js';
import { filesystemTools } from './filesystem.js';
import { marketDataTools } from './market-data.js';
import { priceTools } from './price.js';
import { watchTools } from './watch.js';
import { webAccessTools } from './web-access.js';
import { taskTools } from './tasks.js';
import { riskLimitsTools } from './risk-limits.js';

function assertToolCatalogMatchesRegistry(registry: ToolRegistry): void {
  const registeredToolNames = registry.list().map((tool) => tool.name).sort();
  const knownToolNames = ([...KNOWN_AGENT_TOOL_NAMES] as string[]).sort();
  const missingFromRegistry = knownToolNames.filter((toolName) => !registeredToolNames.includes(toolName));
  const missingFromCatalog = registeredToolNames.filter((toolName) => !knownToolNames.includes(toolName));

  if (missingFromRegistry.length === 0 && missingFromCatalog.length === 0) {
    return;
  }

  throw new Error(
    `Agent tool catalog mismatch: missingFromRegistry=[${missingFromRegistry.join(', ')}], missingFromCatalog=[${missingFromCatalog.join(', ')}]`,
  );
}

function assertBuiltInSkillToolsAreKnown(): void {
  for (const skill of [BASE_SKILL, ...SYSTEM_SKILLS]) {
    const unknownTools = findUnknownSkillTools(skill.requiredTools);
    if (unknownTools.length > 0) {
      throw new Error(`Built-in skill ${skill.id} references unknown requiredTools: ${unknownTools.join(', ')}`);
    }
  }
}

/** Create a registry with all agent tools pre-registered. */
export function createToolRegistry(): ToolRegistry {
  assertBuiltInSkillToolsAreKnown();
  const registry = new ToolRegistry();

  const allTools = [
    ...messagingTools,
    ...memoryTools,
    ...tradingTools,
    ...botManagementTools,
    ...analyticsTools,
    ...codeTools,
    ...filesystemTools,
    ...marketDataTools,
    ...priceTools,
    ...watchTools,
    ...webAccessTools,
    ...taskTools,
    ...riskLimitsTools,
  ];

  for (const tool of allTools) {
    registry.register(tool);
  }

  assertToolCatalogMatchesRegistry(registry);

  return registry;
}

export { ToolRegistry } from './registry.js';
export type { AgentTool, ToolDefinition, ToolResult, ToolContext, ToolCategory } from '@herobids/domain';

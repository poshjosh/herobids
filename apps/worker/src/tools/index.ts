import { BASE_SKILL, KNOWN_AGENT_TOOL_NAMES, SYSTEM_SKILLS, TOOL_CATALOG, findUnknownSkillTools } from '@herobids/domain';
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
import { schemaTools } from './schema.js';
import { accountTools } from './account.js';
import { instrumentTools } from './find-instrument.js';
import { resolverTools } from './resolvers.js';
import { emailTools } from './email.js';
import { changeStrategyPresetTool } from './change-strategy-preset.js';
import { assessStrategyPresetTool } from './assess-strategy-preset.js';
import { platformDocsTools } from './platform-docs.js';
import { skillTools } from './skills.js';
import { createBrowserTools } from './browser.js';
import { httpClientTools } from './http-client.js';
import type { BrowserPoolPort } from '@herobids/domain';

function assertToolCatalogMatchesRegistry(registry: ToolRegistry): void {
  const registeredTools = registry.list();
  const registeredToolNames = registeredTools.map((tool) => tool.name).sort();
  const knownToolNames = ([...KNOWN_AGENT_TOOL_NAMES] as string[]).sort();

  // Name-level check: KNOWN_AGENT_TOOL_NAMES ↔ registry
  const missingFromRegistry = knownToolNames.filter((toolName) => !registeredToolNames.includes(toolName));
  const missingFromKnownNames = registeredToolNames.filter((toolName) => !knownToolNames.includes(toolName));

  // Name-level check: TOOL_CATALOG ↔ registry
  const catalogToolNames = Object.keys(TOOL_CATALOG).sort();
  const missingFromCatalog = catalogToolNames.filter((toolName) => !registeredToolNames.includes(toolName));
  const missingFromCatalogCoverage = registeredToolNames.filter((toolName) => !(toolName in TOOL_CATALOG));

  // Category consistency: every registered tool must match its catalog entry's category
  const categoryMismatches: string[] = [];
  for (const tool of registeredTools) {
    const catalogEntry = TOOL_CATALOG[tool.name];
    if (catalogEntry && catalogEntry.category !== tool.category) {
      categoryMismatches.push(`${tool.name} (catalog=${catalogEntry.category}, registry=${tool.category})`);
    }
  }

  const errors: string[] = [];
  if (missingFromRegistry.length > 0) {
    errors.push(`missingFromRegistry=[${missingFromRegistry.join(', ')}]`);
  }
  if (missingFromKnownNames.length > 0) {
    errors.push(`missingFromKnownNames=[${missingFromKnownNames.join(', ')}]`);
  }
  if (missingFromCatalog.length > 0) {
    errors.push(`missingFromCatalog=[${missingFromCatalog.join(', ')}]`);
  }
  if (missingFromCatalogCoverage.length > 0) {
    errors.push(`missingFromCatalogCoverage=[${missingFromCatalogCoverage.join(', ')}]`);
  }
  if (categoryMismatches.length > 0) {
    errors.push(`categoryMismatches=[${categoryMismatches.join(', ')}]`);
  }

  if (errors.length > 0) {
    throw new Error(`Agent tool catalog mismatch: ${errors.join('; ')}`);
  }
}

function assertBuiltInSkillToolsAreKnown(): void {
  for (const skill of [BASE_SKILL, ...SYSTEM_SKILLS]) {
    const unknownTools = findUnknownSkillTools(skill.requiredTools);
    if (unknownTools.length > 0) {
      throw new Error(`Built-in skill ${skill.id} references unknown requiredTools: ${unknownTools.join(', ')}`);
    }
  }
}

export interface ToolRegistryDeps {
  browserPool?: BrowserPoolPort;
}

/** Create a registry with all agent tools pre-registered. */
export function createToolRegistry(deps?: ToolRegistryDeps): ToolRegistry {
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
    ...createBrowserTools(deps?.browserPool),
    ...httpClientTools,
    ...taskTools,
    ...riskLimitsTools,
    ...schemaTools,
    ...accountTools,
    ...instrumentTools,
    ...resolverTools,
    ...emailTools,
    ...platformDocsTools,
    ...skillTools,
    assessStrategyPresetTool,
    changeStrategyPresetTool,
  ];

  for (const tool of allTools) {
    registry.register(tool);
  }

  assertToolCatalogMatchesRegistry(registry);

  return registry;
}

export { ToolRegistry } from './registry.js';
export type { AgentTool, ToolDefinition, ToolResult, ToolContext, ToolCategory } from '@herobids/domain';

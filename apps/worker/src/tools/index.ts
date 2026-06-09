import { ToolRegistry } from './registry.js';
import { messagingTools } from './messaging.js';
import { memoryTools } from './memory.js';
import { tradingTools } from './trading.js';
import { botManagementTools } from './bots.js';
import { analyticsTools } from './analytics.js';
import { codeTools } from './code.js';
import { marketDataTools } from './market-data.js';

/** Create a registry with all agent tools pre-registered. */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  const allTools = [
    ...messagingTools,
    ...memoryTools,
    ...tradingTools,
    ...botManagementTools,
    ...analyticsTools,
    ...codeTools,
    ...marketDataTools,
  ];

  for (const tool of allTools) {
    registry.register(tool);
  }

  return registry;
}

export { ToolRegistry } from './registry.js';
export type { AgentTool, ToolDefinition, ToolResult, ToolContext, ToolCategory } from '@herobids/domain';

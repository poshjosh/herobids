# Tool Registry

## Key Features

### 1. **Centralized Tool Registry**
```typescript
export class ToolRegistry {
  private tools = new Map<string, AgentTool>();
  
  register(tool: AgentTool): void { ... }
  get(name: string): AgentTool | undefined { ... }
  list(): AgentTool[] { ... }
  
  /** Get OpenAI-format tool definitions for LLM function calling. */
  getDefinitions(filter?: string[]): ToolDefinition[] { ... }
}
```

### 2. **Tool Metadata with Category**
```typescript
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  category: 'read' | 'write' | 'trade';  // ✅ The key metadata!
  execute(params: unknown, ctx: AgentToolContext): Promise<ToolResult>;
}
```

### 3. **Concrete Example**
```typescript
export const messagingTools: AgentTool[] = [
  {
    name: 'send_telegram',
    description: '...',
    parameters: { /* JSON Schema */ },
    category: 'write',  // ✅ Declared at tool definition site
    async execute(params, ctx) { /* implementation */ }
  }
];

// Trading tools are marked 'trade' (which is also mutating)
{ name: 'buy_token', category: 'trade', ... }
{ name: 'list_positions', category: 'trade', ... } // read-only but trading-context
```

### 4. **Tool Organization by Module**
Tools are grouped in separate files by domain:
- trading.ts — buy/sell tools
- positions.ts — list/close positions  
- messaging.ts — send_telegram
- `memory.ts` — get/set memory
- `data.ts` — search tokens, check regime

Then assembled in the registry factory.

---

## How This Solves Your Scout/Judge Problem

With this pattern, your scout tool filtering becomes:

```typescript
// apps/worker/src/agent.ts
import { toolRegistry } from './tools/registry.js';

// Instead of hardcoded list:
const readOnlyScoutTools = toolRegistry.list()
  .filter(tool => tool.category === 'read')
  .map(tool => tool.name);

// Or more nuanced:
const scoutTools = toolRegistry.list()
  .filter(tool => tool.category === 'read' || tool.name === 'check_regime')
  .map(tool => tool.name);

// Scout gets only read-only tools
const scoutDefinitions = toolRegistry.getDefinitions(scoutTools);

// Judge gets everything
const judgeDefinitions = toolRegistry.getDefinitions(); // no filter
```

## Migration Path for HeroBids

### Phase 1: Build Registry Infrastructure (3-4 hours)

1. **Create tool types**
```typescript
// packages/domain/src/tools.ts
export type ToolCategory = 'read' | 'write';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  category: ToolCategory;
  execute(params: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

2. **Create registry**
```typescript
// apps/worker/src/tools/registry.ts
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }
  
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }
  
  list(): ToolDefinition[] {
    return Array.from(this.values());
  }
  
  getByCategory(category: ToolCategory): ToolDefinition[] {
    return this.list().filter(t => t.category === category);
  }
}
```

3. **Extract tool implementations from switch statement**
```typescript
// apps/worker/src/tools/trading.ts
export const tradingTools: ToolDefinition[] = [
  {
    name: 'submit_decision',
    description: 'Submit a trade decision for a specific instrument',
    category: 'write',
    parameters: { /* JSON schema */ },
    async execute(params, ctx) {
      // Move code from case 'submit_decision'
    }
  }
];
```

### Phase 2: Update Agent Runtime (2 hours)

Replace the switch statement with registry lookup:
```typescript
async function executeTool(call: ToolCall): Promise<string | null> {
  const tool = toolRegistry.get(call.tool);
  if (!tool) {
    logger.warn({ tool: call.tool }, 'Unknown tool');
    return `unknown tool: ${call.tool}`;
  }
  
  const result = await tool.execute(call.args, toolContext);
  return result.success ? JSON.stringify(result.data) : result.error;
}
```

### Phase 3: Fix Scout Filtering (30 min)

```typescript
const readOnlyTools = toolRegistry.getByCategory('read');
const readOnlyScoutTools = readOnlyTools.map(t => t.name);
```

---

## Effort Revised

**With Registry Pattern: Medium-Large (1-2 days)**
- Tool registry infrastructure: 3-4 hours
- Migrating 20+ tools from switch to registry: 4-5 hours  
- Testing and validation: 2-3 hours
- **Total: ~10-12 hours**

**Benefits:**
- ✅ Scout filtering is automatic (no hardcoded lists)
- ✅ Adding new tools doesn't require editing switch statements
- ✅ Tool schemas become first-class (can expose via API)
- ✅ Category metadata enables other features (capability gates, cost tracking)
- ✅ Matches proven pattern from your other project

**Recommendation:** Adopt this pattern. It's more effort upfront but pays off immediately and sets you up for a proper skill/tool marketplace later.

## References

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/aitradingbot/src/agents/tools/index.ts)

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/aitradingbot/src/agents/types.ts)

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/aitradingbot/src/agents/tools/trading.ts)

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/aitradingbot/src/agents/types.ts)

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/aitradingbot/src/agents/tools/trading.ts)

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/aitradingbot/src/agents/tools/messaging.ts)

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/aitradingbot/src/agents/tools/positions.ts)

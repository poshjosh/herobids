import type { AgentTool, ToolDefinition } from '@herobids/domain';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Tool registry — maps tool names to implementations. */
export class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  /** Get tools filtered by category predicate */
  filterByCategory(predicate: (category: string) => boolean): AgentTool[] {
    return this.list().filter((tool) => predicate(tool.category));
  }

  /** Get provider-neutral tool definitions for LLM tool calling. */
  getDefinitions(filter?: string[]): ToolDefinition[] {
    const tools = filter
      ? this.list().filter((t) => filter.includes(t.name))
      : this.list();

    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    }));
  }

  /** Get all read-only tool names (categories starting with 'read-') */
  getReadOnlyToolNames(): string[] {
    return this.list()
      .filter((tool) => tool.category.startsWith('read-'))
      .map((tool) => tool.name);
  }
}

/** Helper to convert Zod schema to JSON Schema for LLM function calling */
export function convertZodToJsonSchema(zodSchema: AgentTool['parametersSchema']): Record<string, unknown> {
  return zodToJsonSchema(zodSchema, {
    target: 'openAi',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}

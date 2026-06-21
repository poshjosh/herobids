import { z } from 'zod';
import type { AgentTool, ToolDefinition } from '@herobids/domain';
import { zodToJsonSchema } from 'zod-to-json-schema';

function normalizeRequiredFields(
  schema: Record<string, unknown>,
  zodSchema: AgentTool['parametersSchema'],
): Record<string, unknown> {
  if (!(zodSchema instanceof z.ZodObject)) {
    return schema;
  }

  const shape = zodSchema.shape as Record<string, z.ZodTypeAny>;
  const normalizedRequired = Object.entries(shape)
    .filter(([, fieldSchema]) => !fieldSchema.isOptional())
    .map(([fieldName]) => fieldName);

  return {
    ...schema,
    required: normalizedRequired,
  };
}

/** Tool registry — maps tool names to implementations. */
export class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
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
      ...(t.promptGuidance ? { promptGuidance: t.promptGuidance } : {}),
    }));
  }

  /** Get all read-only tool names (categories starting with 'read-') */
  getReadOnlyToolNames(): string[] {
    return this.list()
      .filter((tool) => tool.category.startsWith('read-'))
      .map((tool) => tool.name);
  }
}

/**
 * Recursively convert JSON Schema Draft 4 exclusive min/max boolean flags to
 * Draft 7 numeric form. `zod-to-json-schema` with `target: 'openAi'` emits
 * the Draft 4 pattern `{ minimum: 0, exclusiveMinimum: true }` for
 * `z.number().positive()`. Many providers (e.g. DeepSeek) expect Draft 7 where
 * `exclusiveMinimum` is a number, not a boolean, and reject the boolean form
 * with a 400 error.
 *
 * Draft 4 → Draft 7:
 *   { minimum: N, exclusiveMinimum: true }  →  { exclusiveMinimum: N }
 *   { maximum: N, exclusiveMaximum: true }  →  { exclusiveMaximum: N }
 */
function normalizeDraft4ExclusiveBounds(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = normalizeDraft4ExclusiveBounds(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item !== null && typeof item === 'object'
          ? normalizeDraft4ExclusiveBounds(item as Record<string, unknown>)
          : item,
      );
    } else {
      result[key] = value;
    }
  }

  // Convert Draft 4 boolean exclusiveMinimum → Draft 7 numeric exclusiveMinimum
  if (result['exclusiveMinimum'] === true && 'minimum' in result) {
    result['exclusiveMinimum'] = result['minimum'];
    delete result['minimum'];
  }

  // Convert Draft 4 boolean exclusiveMaximum → Draft 7 numeric exclusiveMaximum
  if (result['exclusiveMaximum'] === true && 'maximum' in result) {
    result['exclusiveMaximum'] = result['maximum'];
    delete result['maximum'];
  }

  return result;
}

/** Helper to convert Zod schema to JSON Schema for LLM function calling */
export function convertZodToJsonSchema(
  zodSchema: AgentTool['parametersSchema'],
): Record<string, unknown> {
  const schema = zodToJsonSchema(zodSchema, {
    target: 'openAi',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  // The OpenAI-target JSON schema can over-mark top-level optional properties as
  // required. Normalize the required list from the Zod object shape so plain
  // optionals and effect-wrapped optionals preserve their intended contract.
  const normalized = normalizeRequiredFields(schema, zodSchema);

  // Convert Draft 4 boolean exclusiveMinimum/Maximum → Draft 7 numeric form so
  // providers that reject boolean exclusive bounds (e.g. DeepSeek) accept the schema.
  return normalizeDraft4ExclusiveBounds(normalized);
}

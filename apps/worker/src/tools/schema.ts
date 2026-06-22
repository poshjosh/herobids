import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { getToolSchema, listToolSchemaNames } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- get_schema ---

const GetSchemaParamsSchema = z.object({
  name: z.string().min(1).describe('Schema name to fetch (dot-path, e.g. "update_own_config.technical"). Use "all" to list all available schema names.'),
});

const getSchemaTool: AgentTool = {
  name: 'get_schema',
  description: 'Fetch the JSON Schema for a named config parameter or tool sub-schema. Use this before constructing payloads for update_own_config, create_bot, publish_artifact, execute_code, or submit_decision. Call with name="all" to list all available schemas.',
  parametersSchema: GetSchemaParamsSchema,
  parameters: convertZodToJsonSchema(GetSchemaParamsSchema),
  category: 'read-config',
  promptGuidance: 'Call get_schema("all") first to see what schemas are available, then fetch the specific schema you need before constructing any payload with ambiguous/optional fields.',
  async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { name } = params as z.infer<typeof GetSchemaParamsSchema>;

    if (name === 'all') {
      const names = listToolSchemaNames();
      return {
        success: true,
        data: {
          ok: true,
          schemas: names.map((n) => {
            const entry = getToolSchema(n);
            return {
              name: n,
              description: entry?.description,
              version: entry?.version,
            };
          }),
          hint: 'Call get_schema("<name>") with one of these names to get the full JSON Schema with examples.',
        },
      };
    }

    const entry = getToolSchema(name);
    if (!entry) {
      const names = listToolSchemaNames();
      return {
        success: false,
        fault: false,
        error: `Unknown schema: "${name}". Available schemas: ${names.join(', ')}`,
        errorCode: 'schema.not_found',
        data: { availableSchemas: names },
      };
    }

    return {
      success: true,
      data: {
        ok: true,
        name,
        ...entry,
      },
    };
  },
};

export const schemaTools: AgentTool[] = [getSchemaTool];

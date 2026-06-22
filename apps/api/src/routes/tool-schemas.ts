import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getToolSchema, listToolSchemaNames, getAllToolSchemas } from '@herobids/domain';

const ToolSchemasQuerySchema = z.object({
  name: z.string().optional(),
});

/**
 * GET /api/v1/tool-schemas
 * GET /api/v1/tool-schemas?name=update_own_config.technical
 *
 * Returns JSON Schema (Draft 7) for tool sub-schemas that agents
 * cannot otherwise discover. Includes examples and version info.
 */
export async function toolSchemaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/tool-schemas', async (request, reply) => {
    const query = ToolSchemasQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        ok: false,
        error: 'invalid_query',
        details: query.error.issues,
      });
    }

    const { name } = query.data;

    if (name) {
      const entry = getToolSchema(name);
      if (!entry) {
        return reply.status(404).send({
          ok: false,
          error: 'schema_not_found',
          message: `No schema found for "${name}"`,
          availableSchemas: listToolSchemaNames(),
        });
      }

      return reply.send({
        ok: true,
        schema: {
          $id: name,
          $schema: 'http://json-schema.org/draft-07/schema#',
          version: entry.version,
          description: entry.description,
          ...entry.schema,
        },
        example: entry.example,
        version: entry.version,
      });
    }

    // List all schemas
    const all = getAllToolSchemas();
    const schemas = Object.entries(all).map(([schemaName, entry]) => ({
      name: schemaName,
      description: entry.description,
      version: entry.version,
    }));

    return reply.send({
      ok: true,
      schemas,
    });
  });
}

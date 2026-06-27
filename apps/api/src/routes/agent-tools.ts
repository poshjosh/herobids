import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TOOL_CATALOG, TOOL_CATEGORY_LABELS } from '@herobids/domain';

const AgentToolsQuerySchema = z.object({
  category: z.string().optional(),
});

export async function agentToolsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/agent-tools', async (request, reply) => {
    const query = AgentToolsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        ok: false,
        error: 'invalid_query',
        details: query.error.issues,
      });
    }

    const { category } = query.data;

    let tools = Object.entries(TOOL_CATALOG).map(([name, entry]) => ({
      name,
      category: entry.category,
      description: entry.description,
    }));

    if (category) {
      tools = tools.filter((t) => t.category === category);
    }

    // Derive category summary from the full catalog (unfiltered)
    const categoryCounts = new Map<string, number>();
    for (const entry of Object.values(TOOL_CATALOG)) {
      categoryCounts.set(entry.category, (categoryCounts.get(entry.category) ?? 0) + 1);
    }
    const categories = Array.from(categoryCounts.entries()).map(([name, count]) => ({
      name,
      label: TOOL_CATEGORY_LABELS[name] ?? name,
      count,
    }));

    return reply.send({ ok: true, tools, categories });
  });
}

import type { FastifyInstance } from 'fastify';
import { getProviderCatalog } from '../providers/registry.js';

function normalizeIfNoneMatch(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  return value.split(',').map((part) => part.trim()).find((part) => part.length > 0) ?? null;
}

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/providers/catalog', async (request, reply) => {
    const catalog = getProviderCatalog();
    const ifNoneMatch = normalizeIfNoneMatch(request.headers['if-none-match']);

    reply.header('Cache-Control', 'public, max-age=3600');
    reply.header('ETag', catalog.etagHeader);

    if (ifNoneMatch === catalog.etagHeader || ifNoneMatch === catalog.response.etag) {
      return reply.status(304).send();
    }

    return reply.send(catalog.response);
  });
}
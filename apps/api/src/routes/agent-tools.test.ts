import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { agentToolsRoutes } from './agent-tools.js';

describe('GET /api/v1/agent-tools', () => {
  it('returns 200 with all 47 tools and 12 category summaries', async () => {
    const app = Fastify();
    await agentToolsRoutes(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent-tools',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools).toHaveLength(47);

    for (const tool of body.tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('category');
      expect(tool).toHaveProperty('description');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.category).toBe('string');
      expect(typeof tool.description).toBe('string');
    }

    expect(Array.isArray(body.categories)).toBe(true);
    expect(body.categories).toHaveLength(12);

    for (const cat of body.categories) {
      expect(cat).toHaveProperty('name');
      expect(cat).toHaveProperty('label');
      expect(cat).toHaveProperty('count');
      expect(typeof cat.name).toBe('string');
      expect(typeof cat.label).toBe('string');
      expect(typeof cat.count).toBe('number');
      expect(cat.count).toBeGreaterThan(0);
    }

    // Verify total counts across categories sum to 47
    const totalInCategories = body.categories.reduce(
      (sum: number, c: { count: number }) => sum + c.count,
      0,
    );
    expect(totalInCategories).toBe(47);
  });

  it('filters by ?category=execute-trade returning exactly 2 tools', async () => {
    const app = Fastify();
    await agentToolsRoutes(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent-tools?category=execute-trade',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.tools).toHaveLength(2);
    expect(body.tools.every((t: { category: string }) => t.category === 'execute-trade')).toBe(
      true,
    );

    const names = body.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['create_bot', 'submit_decision']);

    // Categories summary is still unfiltered
    expect(body.categories).toHaveLength(12);
  });

  it('returns empty tools array but full categories for unknown category', async () => {
    const app = Fastify();
    await agentToolsRoutes(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent-tools?category=nonexistent',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.tools).toEqual([]);
    expect(body.categories).toHaveLength(12);
  });
});

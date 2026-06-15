import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { providerRoutes } from './providers.js';

describe('GET /providers/catalog', () => {
  it('returns the provider catalog with custom mode and cache headers', async () => {
    const app = Fastify();
    await providerRoutes(app);

    const res = await app.inject({
      method: 'GET',
      url: '/providers/catalog',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers.etag).toBeTruthy();

    const body = res.json<{
      schemaVersion: string;
      etag: string;
      providers: Array<{ id: string; connections?: { autoCreatesTradingBinding: boolean } }>;
      customMode: { connections: { allowFreeformProvider: boolean } };
    }>();

    expect(body.schemaVersion).toBe('v1');
    expect(body.etag).toBeTruthy();
    expect(body.providers.map((provider) => provider.id)).toEqual(expect.arrayContaining(['hyperliquid', 'bybit', '1inch', 'jupiter']));
    expect(body.providers.find((provider) => provider.id === 'hyperliquid')?.connections?.autoCreatesTradingBinding).toBe(true);
    expect(body.customMode.connections.allowFreeformProvider).toBe(true);
  });

  it('returns 304 when the ETag matches', async () => {
    const app = Fastify();
    await providerRoutes(app);

    const first = await app.inject({
      method: 'GET',
      url: '/providers/catalog',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/providers/catalog',
      headers: { 'if-none-match': first.headers.etag as string },
    });

    expect(res.statusCode).toBe(304);
    expect(res.body).toBe('');
  });
});
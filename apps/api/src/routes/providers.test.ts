import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { providerRoutes } from './providers.js';
import { listProviderRegistry, findProviderRegistryEntry } from '../providers/registry.js';
import { validateProviderSecrets } from '../providers/validator.js';

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

describe('Provider registry/catalog/validator contract', () => {
  const registry = listProviderRegistry();

  it('every registry entry appears in the public catalog with its required credential fields', async () => {
    const app = Fastify();
    await providerRoutes(app);

    const res = await app.inject({ method: 'GET', url: '/providers/catalog' });
    const body = res.json<{ providers: Array<{ id: string; credentials?: { fields: Array<{ key: string }> } }> }>();
    const catalogById = new Map(body.providers.map((p) => [p.id, p]));

    for (const entry of registry) {
      const catalogEntry = catalogById.get(entry.id);
      expect(catalogEntry, `provider "${entry.id}" missing from catalog`).toBeDefined();

      if (entry.credentials) {
        const requiredFields = entry.credentials.fields.filter((f) => f.required);
        const catalogKeys = (catalogEntry?.credentials?.fields ?? []).map((f) => f.key);

        for (const field of requiredFields) {
          expect(catalogKeys, `required field "${field.key}" for "${entry.id}" missing from catalog`).toContain(field.key);
        }
      }
    }
  });

  it('valid credential payloads pass required-field validation for every provider with credentials', () => {
    for (const entry of registry) {
      if (!entry.credentials) continue;

      // Build a payload with format-valid values for required fields.
      // Use values that satisfy common patterns: EVM addresses, hex keys, simple strings.
      const validPayload: Record<string, string> = {};
      for (const field of entry.credentials.fields) {
        if (!field.required) continue;
        const pattern = field.validation?.pattern;
        if (pattern?.includes('0x[0-9a-fA-F]{40}')) {
          validPayload[field.key] = '0x0000000000000000000000000000000000000001';
        } else if (pattern?.includes('0x[0-9a-fA-F]{64}') || pattern?.includes('[0-9a-fA-F]{64}')) {
          validPayload[field.key] = '0x' + '0'.repeat(64);
        } else {
          validPayload[field.key] = 'valid-value';
        }
      }

      const errors = validateProviderSecrets(entry.id, validPayload, entry);
      expect(errors, `validation failed for "${entry.id}" with valid payload: ${JSON.stringify(errors)}`).toHaveLength(0);
    }
  });

  it('findProviderRegistryEntry returns the entry matching listProviderRegistry for known providers', () => {
    for (const entry of registry) {
      const found = findProviderRegistryEntry(entry.id);
      expect(found?.id).toBe(entry.id);
      expect(found?.displayName).toBe(entry.displayName);
    }
  });
});
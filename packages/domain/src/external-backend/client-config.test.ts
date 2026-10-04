import { describe, it, expect } from 'vitest';
import { ExternalBackendDefinitionSchema } from '../config/external-backends.js';
import { buildExternalBackendClientConfig } from './client-config.js';

describe('buildExternalBackendClientConfig', () => {
  it('maps endpoint and caller fields onto the client config', () => {
    const definition = ExternalBackendDefinitionSchema.parse({
      backendId: 'example-echo',
      endpoint: { baseUrl: 'http://localhost:8080', requestTimeoutMs: 15_000 },
      caller: { consumerId: 'herobids', keyId: 'current', hmacSecretRef: 'EXAMPLE_HMAC_SECRET' },
    });
    expect(buildExternalBackendClientConfig(definition, 'test-secret')).toEqual({
      baseUrl: 'http://localhost:8080',
      consumerId: 'herobids',
      keyId: 'current',
      hmacSecret: 'test-secret',
      requestTimeoutMs: 15_000,
      protocol: 'rest',
      toolProtocolOverrides: undefined,
      mcpPath: undefined,
      backendId: 'example-echo',
    });
  });

  it('carries the endpoint protocol, per-tool overrides and mcpPath onto the client config', () => {
    const definition = ExternalBackendDefinitionSchema.parse({
      backendId: 'example-echo',
      endpoint: {
        baseUrl: 'http://localhost:8080',
        protocol: 'rest',
        toolProtocolOverrides: { get_quote: 'mcp' },
        mcpPath: '/mcp',
      },
      caller: { consumerId: 'herobids', keyId: 'current', hmacSecretRef: 'EXAMPLE_HMAC_SECRET' },
    });

    expect(buildExternalBackendClientConfig(definition, 'test-secret')).toMatchObject({
      protocol: 'rest',
      toolProtocolOverrides: { get_quote: 'mcp' },
      mcpPath: '/mcp',
    });
  });
});

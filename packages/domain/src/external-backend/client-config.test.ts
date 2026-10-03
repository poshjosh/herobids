import { describe, it, expect } from 'vitest';
import { ExternalBackendDefinitionSchema } from '../config/external-backends.js';
import { buildExternalBackendClientConfig } from './client-config.js';

describe('buildExternalBackendClientConfig', () => {
  it('maps endpoint and caller fields onto the client config', () => {
    const definition = ExternalBackendDefinitionSchema.parse({
      backendId: 'example-echo',
      endpoint: { baseUrl: 'http://localhost:8080', requestTimeoutMs: 15_000 },
      caller: { consumerId: 'herobids', keyId: 'current', hmacSecretRef: 'EXAMPLE_HMAC_SECRET' },
      descriptorPinning: { mode: 'maxAge', seconds: 3600 },
    });
    expect(buildExternalBackendClientConfig(definition, 'test-secret')).toEqual({
      baseUrl: 'http://localhost:8080',
      consumerId: 'herobids',
      keyId: 'current',
      hmacSecret: 'test-secret',
      requestTimeoutMs: 15_000,
    });
  });
});

import type { ExternalBackendDefinition } from '../config/external-backends.js';
import type { ExternalBackendClientConfig } from './client.js';

/** Maps a registry definition + its resolved HMAC secret onto the client config. */
export function buildExternalBackendClientConfig(
  definition: ExternalBackendDefinition,
  hmacSecret: string,
): ExternalBackendClientConfig {
  return {
    baseUrl: definition.endpoint.baseUrl,
    consumerId: definition.caller.consumerId,
    keyId: definition.caller.keyId,
    hmacSecret,
    requestTimeoutMs: definition.endpoint.requestTimeoutMs,
  };
}

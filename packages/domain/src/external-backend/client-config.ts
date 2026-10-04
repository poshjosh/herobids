import type { ExternalBackendDefinition } from '../config/external-backends.js';
import type { ExternalBackendClientConfig } from './client.js';
import type { MetricsSink } from './metrics.js';

/** Optional composition-site inputs the helper cannot derive from the registry. */
export interface BuildExternalBackendClientConfigOptions {
  /** Metrics sink injected by the app (see docs/tech/architecture/observability.md). */
  metrics?: MetricsSink;
}

/** Maps a registry definition + its resolved HMAC secret onto the client config. */
export function buildExternalBackendClientConfig(
  definition: ExternalBackendDefinition,
  hmacSecret: string,
  options?: BuildExternalBackendClientConfigOptions,
): ExternalBackendClientConfig {
  return {
    baseUrl: definition.endpoint.baseUrl,
    consumerId: definition.caller.consumerId,
    keyId: definition.caller.keyId,
    hmacSecret,
    requestTimeoutMs: definition.endpoint.requestTimeoutMs,
    protocol: definition.endpoint.protocol,
    toolProtocolOverrides: definition.endpoint.toolProtocolOverrides,
    mcpPath: definition.endpoint.mcpPath,
    backendId: definition.backendId,
    // `metrics` is injected at the composition site via `options.metrics` (this
    // helper has no sink of its own). Omit the key when absent so unconfigured
    // clients keep the no-op default path. See docs/tech/architecture/observability.md.
    ...(options?.metrics ? { metrics: options.metrics } : {}),
  };
}

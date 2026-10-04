// Agent-container composition of the external-backend ports (read + write).
//
// The worker resolves the trading backend registry entry + its HMAC secret and
// forwards it as EXTERNAL_BACKEND_CONFIG_JSON (a ResolvedExternalBackend). This
// module turns that payload into the read port and the subject-bound write port
// the tool context exposes. The HMAC secret lives in the client only; it never
// reaches a tool, and the subject is bound here so the tools never see it.
import { ResolvedExternalBackendSchema, type ResolvedExternalBackend } from '@herobids/domain';
import {
  buildExternalBackendClientConfig,
  createExternalBackendClient,
  createLoggerMetricsSink,
  type ExternalBackendSubject,
} from '@herobids/domain/external-backend';
import { createExternalBackendReadBoundary, type ExternalBackendReadBoundary } from './read-adapter.js';
import {
  createSubjectBoundWriteBoundary,
  createExternalBackendWriteBoundary,
  type ExternalBackendToolWriteBoundary,
} from './write-adapter.js';

export interface AgentExternalBackendPortsLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface AgentExternalBackendPortsInput {
  /** Raw EXTERNAL_BACKEND_CONFIG_JSON; carries the HMAC secret. */
  rawConfigJson: string | undefined;
  /** Platform owner id of the agent (empty = unknown). */
  ownerId: string;
  agentId: string;
  logger: AgentExternalBackendPortsLogger;
}

export interface AgentExternalBackendPorts {
  read: ExternalBackendReadBoundary | undefined;
  write: ExternalBackendToolWriteBoundary | undefined;
}

const NO_PORTS: AgentExternalBackendPorts = { read: undefined, write: undefined };
const PARSE_FAILED_MESSAGE = 'Failed to parse EXTERNAL_BACKEND_CONFIG_JSON — read tools fall back to direct DB';
const NOT_CONFIGURED_MESSAGE =
  'Traderton boundary not fully configured — read tools use direct DB; adjust_risk_limits write hard-fails';

// The payload carries the HMAC secret, and JSON.parse / Zod messages can echo
// input fragments, so failures are logged with a fixed message plus a kind and
// issue codes/paths only — never an error message or a value.
function parseResolvedBackend(
  rawConfigJson: string,
  logger: AgentExternalBackendPortsLogger,
): ResolvedExternalBackend | undefined {
  let json: unknown;
  try {
    json = JSON.parse(rawConfigJson);
  } catch {
    logger.warn({ reason: 'invalid_json' }, PARSE_FAILED_MESSAGE);
    return undefined;
  }
  const parsed = ResolvedExternalBackendSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path.join('.') }));
    logger.warn({ reason: 'invalid_schema', issues }, PARSE_FAILED_MESSAGE);
    return undefined;
  }
  return parsed.data;
}

/**
 * Build the agent's read port and subject-bound write port. Absent or invalid
 * payload, or no owner id → no ports (read tools fall back where they can; the
 * `adjust_risk_limits` write hard-fails).
 */
export function buildAgentExternalBackendPorts(input: AgentExternalBackendPortsInput): AgentExternalBackendPorts {
  const { rawConfigJson, ownerId, agentId, logger } = input;
  if (!rawConfigJson) {
    logger.info({ hasBackendConfig: false, hasOwnerId: !!ownerId }, NOT_CONFIGURED_MESSAGE);
    return NO_PORTS;
  }
  const resolved = parseResolvedBackend(rawConfigJson, logger);
  if (resolved === undefined) return NO_PORTS;
  if (!ownerId) {
    logger.info({ hasBackendConfig: true, hasOwnerId: false }, NOT_CONFIGURED_MESSAGE);
    return NO_PORTS;
  }
  const { definition, hmacSecret } = resolved;
  const subject: ExternalBackendSubject = { ownerId, actor: { type: 'agent', id: agentId } };
  // metrics: reuse the injected ports logger (the agent runs in its own
  // container). See docs/tech/architecture/observability.md.
  const client = createExternalBackendClient(
    buildExternalBackendClientConfig(definition, hmacSecret, { metrics: createLoggerMetricsSink(logger) }),
  );
  logger.info(
    { backendId: definition.backendId, baseUrl: definition.endpoint.baseUrl },
    'Traderton read + write boundaries enabled — read tools + risk-limit writes route over REST',
  );
  const read = createExternalBackendReadBoundary(client, subject, definition.endpoint.requestTimeoutMs);
  // The binding mints one idempotency key per write; tools supply only tool
  // name + payload + deadline.
  const write = createSubjectBoundWriteBoundary(createExternalBackendWriteBoundary(client), subject);
  return { read, write };
}

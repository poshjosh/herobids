// Phase 4 (ADR 017 §4) — discover a backend's advertised tools over MCP
// `tools/list`. This is the ONLY discovery entry point exposed from the
// external-backend subpath; the transport seam itself stays internal (D14). Tool
// CALLS still go REST (D27) — this only reads the tool catalogue.

import { McpTransport, type ListToolsOutcome } from './transports/mcp-transport.js';
import type { ExternalBackendDefinition } from '../config/external-backends.js';

export type { DiscoveredBackendTool } from './transports/mcp-transport.js';
export { SKILL_REFS_META_KEY } from './transports/mcp-transport.js';

/**
 * Discover `tools/list` for a backend over MCP, returning the advertised tools
 * (each with its skill refs) or an `unreachable` outcome. Never throws.
 */
export async function discoverExternalBackendTools(
  definition: ExternalBackendDefinition,
  hmacSecret: string,
): Promise<ListToolsOutcome> {
  const mcpPath = definition.endpoint.mcpPath;
  if (!mcpPath) {
    return { kind: 'unreachable', message: 'backend has no mcpPath configured for discovery' };
  }
  const transport = new McpTransport({
    baseUrl: definition.endpoint.baseUrl.replace(/\/+$/, ''),
    mcpPath,
    identity: { consumerId: definition.caller.consumerId, keyId: definition.caller.keyId, secret: hmacSecret },
  });
  return transport.listTools(definition.endpoint.requestTimeoutMs);
}

export type { ListToolsOutcome };

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

/** Options for {@link discoverWithRetry} — operator config, never hardcoded at the call site. */
export interface DiscoveryRetryOptions {
  /** Total attempts, including the first. 1 = no retry. */
  maxAttempts: number;
  /** Delay before the 2nd attempt; doubles each subsequent attempt. */
  baseDelayMs: number;
  /** Upper bound on any single retry delay. */
  maxDelayMs: number;
}

/**
 * Retry a `tools/list` discovery attempt with exponential backoff, closing the
 * "one transient failure strands the agent without trading tools all session"
 * gap (docs/features/2026/10/05/001-backend-tool-discovery-retry). Pure over an
 * injected `sleep` so it stays unit-testable without real timers. Only retries
 * `unreachable` outcomes — `attempt` itself never throws (same contract as
 * `discoverExternalBackendTools`), so this never throws either.
 */
export async function discoverWithRetry(
  attempt: () => Promise<ListToolsOutcome>,
  options: DiscoveryRetryOptions,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<ListToolsOutcome> {
  let last: ListToolsOutcome = { kind: 'unreachable', message: 'no discovery attempt made' };
  for (let attemptIndex = 0; attemptIndex < options.maxAttempts; attemptIndex++) {
    last = await attempt();
    if (last.kind === 'ok') return last;
    const isLastAttempt = attemptIndex === options.maxAttempts - 1;
    if (!isLastAttempt) {
      const delayMs = Math.min(options.baseDelayMs * 2 ** attemptIndex, options.maxDelayMs);
      await sleep(delayMs);
    }
  }
  return last;
}

// The single composition point of the transport seam: the only file that names
// a concrete transport class (I2). T2.3 registers `mcp` here.

import type { ExternalBackendProtocol } from '../../config/external-backends.js';
import type { SigningIdentity } from '../sign.js';
import { McpTransport } from './mcp-transport.js';
import { RestTransport } from './rest-transport.js';
import type { ExternalBackendTransport } from './transport.js';

export interface TransportSelectorOptions {
  baseUrl: string;
  identity: SigningIdentity;
  protocol: ExternalBackendProtocol;
  toolProtocolOverrides?: Readonly<Record<string, ExternalBackendProtocol>>;
  mcpPath?: string;
}

/** Resolves the transport for a tool; `undefined` selects the endpoint protocol. */
export type TransportForTool = (toolName: string | undefined) => ExternalBackendTransport;

type TransportFactory = (options: TransportSelectorOptions) => ExternalBackendTransport;

/** The config schema requires `mcpPath` whenever `mcp` is used; this guards the client-side too. */
function requireMcpPath(options: TransportSelectorOptions): string {
  if (options.mcpPath === undefined) {
    throw new Error('external_backend.mcp_path_missing: protocol mcp requires an mcpPath');
  }
  return options.mcpPath;
}

const TRANSPORT_FACTORIES: Partial<Record<ExternalBackendProtocol, TransportFactory>> = {
  rest: ({ baseUrl, identity }) => new RestTransport({ baseUrl, identity }),
  mcp: (options) => new McpTransport({ baseUrl: options.baseUrl, mcpPath: requireMcpPath(options), identity: options.identity }),
};

/**
 * Instantiates every protocol the config uses (endpoint protocol ∪ override
 * values) once, up front. A used protocol with no registered transport is a
 * fatal misconfiguration and throws at client construction (P3-18).
 */
export function createTransportSelector(options: TransportSelectorOptions): TransportForTool {
  const instances = new Map<ExternalBackendProtocol, ExternalBackendTransport>();
  const instantiate = (protocol: ExternalBackendProtocol): ExternalBackendTransport => {
    const existing = instances.get(protocol);
    if (existing) return existing;
    const factory = TRANSPORT_FACTORIES[protocol];
    if (!factory) {
      throw new Error(`external_backend.protocol_unavailable: no transport is registered for protocol '${protocol}'`);
    }
    const transport = factory(options);
    instances.set(protocol, transport);
    return transport;
  };

  const endpointTransport = instantiate(options.protocol);
  const overrides = new Map(
    Object.entries(options.toolProtocolOverrides ?? {}).map(
      ([toolName, protocol]): [string, ExternalBackendTransport] => [toolName, instantiate(protocol)],
    ),
  );

  return (toolName) => (toolName === undefined ? undefined : overrides.get(toolName)) ?? endpointTransport;
}

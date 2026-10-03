// The MCP transport (Step 10 plan §2.5; ADR 016; Phase 3 T2.3). Speaks the
// legacy Streamable HTTP era with the official client SDK, signing every frame
// with the UNMODIFIED `signRequest` through a fetch middleware so the wire
// bytes are the signed bytes. It owns NO idempotency, retry, deadline
// arithmetic or result mapping — those stay in the client (the seam contract).
//
// It has no `lookupStatus` (D15): a stateless MCP endpoint offers no
// non-executing status read, so the client resolves `in_progress` by a same-key
// re-issue. It NEVER calls tools/list (D16 — the verified descriptor is the sole
// schema authority) and NEVER throws (every failure maps to `transport_error`).
//
// The SDK is loaded by a lazy `import()` on first invoke (P3-37): REST-only
// processes (all of staging/prod, D19) never execute SDK code, and only
// `import type` reaches the module top so no SDK value is referenced at load.

import type { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { SigningIdentity } from '../sign.js';
import { createSigningFetch } from './mcp-signing-fetch.js';
import { decodeCallToolResult, decodeMcpError, type McpErrorSdk } from './mcp-wire.js';
import type {
  ExternalBackendTransport,
  TransportAttempt,
  TransportInvocation,
  TransportOutcome,
} from './transport.js';

export interface McpTransportOptions {
  /** Already trimmed of trailing slashes by the client. */
  baseUrl: string;
  /** The MCP endpoint path, signed on every frame (required for protocol `mcp`). */
  mcpPath: string;
  identity: SigningIdentity;
}

const CLIENT_INFO = { name: 'herobids', version: '1.0.0' } as const;
const NON_OBJECT_PAYLOAD_MESSAGE = 'mcp arguments must be an object';

/** The subset of the SDK module this transport uses, inferred from the dynamic import. */
type McpClientSdk = typeof import('@modelcontextprotocol/client');

// The import() promise is cached: the SDK is parsed once per process, on first
// MCP invoke, and reused for every later call.
let sdkPromise: Promise<McpClientSdk> | undefined;
function loadMcpClientSdk(): Promise<McpClientSdk> {
  if (sdkPromise === undefined) {
    sdkPromise = import('@modelcontextprotocol/client');
  }
  return sdkPromise;
}

function isObjectPayload(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload);
}

export class McpTransport implements ExternalBackendTransport {
  private readonly baseUrl: string;
  private readonly mcpPath: string;
  private readonly identity: SigningIdentity;

  constructor(options: McpTransportOptions) {
    this.baseUrl = options.baseUrl;
    this.mcpPath = options.mcpPath;
    this.identity = options.identity;
  }

  async invoke(invocation: TransportInvocation, attempt: TransportAttempt): Promise<TransportOutcome> {
    // n37: MCP `arguments` must be an object. No registered tool has a
    // non-object payload, so this is a caller programming error — fail without
    // any network I/O.
    if (!isObjectPayload(invocation.payload)) {
      return { kind: 'transport_error', message: NON_OBJECT_PAYLOAD_MESSAGE };
    }

    const sdk = await loadMcpClientSdk();
    // One signal bounds the WHOLE exchange (connect + the single tools/call),
    // threaded into the signing fetch, connect and callTool (P3-38 attempt
    // timeout). `close()` reaps the un-aborted legacy POST the SDK may leave.
    const exchange = AbortSignal.timeout(attempt.timeoutMs);
    const client: Client = new sdk.Client(CLIENT_INFO);
    const transport: StreamableHTTPClientTransport = new sdk.StreamableHTTPClientTransport(
      new URL(`${this.baseUrl}${this.mcpPath}`),
      {
        fetch: createSigningFetch({
          identity: this.identity,
          signedPath: this.mcpPath,
          deadlineAt: invocation.deadlineAt,
          signal: exchange,
        }),
      },
    );

    try {
      await client.connect(transport, { signal: exchange, timeout: attempt.timeoutMs });
      const result = await client.callTool(
        {
          name: invocation.toolName,
          arguments: invocation.payload,
          _meta: {
            contractVersion: invocation.contractVersion,
            requestId: invocation.requestId,
            idempotencyKey: invocation.idempotencyKey,
            correlationId: invocation.correlationId,
            issuedAt: invocation.issuedAt,
            deadlineAt: invocation.deadlineAt,
            caller: invocation.caller,
            subject: invocation.subject,
          },
        },
        { signal: exchange, timeout: attempt.timeoutMs },
      );
      return decodeCallToolResult(result);
    } catch (err) {
      return decodeMcpError(err, sdk satisfies McpErrorSdk);
    } finally {
      // Close reaps the connection; a close failure must never mask the result.
      await client.close().catch(() => undefined);
    }
  }
}

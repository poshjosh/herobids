// The MCP transport (Step 10 plan §2.5; ADR 016; Phase 3 T2.3). Speaks the
// legacy Streamable HTTP era with the official client SDK, signing every frame
// with the UNMODIFIED `signRequest` through a fetch middleware so the wire
// bytes are the signed bytes. It owns NO idempotency, retry, deadline
// arithmetic or result mapping — those stay in the client (the seam contract).
//
// It has no `lookupStatus` (D15): a stateless MCP endpoint offers no
// non-executing status read, so the client resolves `in_progress` by a same-key
// re-issue. It NEVER throws (every failure maps to a transport error / unreachable).
//
// Phase 4 (ADR 017 §4, D25/D27): `listTools()` DISCOVERS the backend's tools over
// MCP `tools/list` (superseding D16's descriptor-as-sole-authority). Tool CALLS
// still stay REST in staging/prod (D27); `invoke()` here is used only where the
// MCP call path is explicitly enabled (dev/test).
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

/**
 * The neutral `_meta` key under which a backend's `tools/list` entry declares
 * the skill ref(s) it belongs to (Phase 4 P4-1). Must match Traderton's
 * `SKILL_REFS_META_KEY`. SEP-2640 defines no tool→skill key, so this uses the
 * Agent Skills vocabulary; the value is an array of `owner/repo/skill` refs.
 */
export const SKILL_REFS_META_KEY = 'io.agentskills/skillRefs';

/** One advertised tool from a backend's MCP `tools/list` (Phase 4 discovery). */
export interface DiscoveredBackendTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Skill refs this tool belongs to, read from `_meta[SKILL_REFS_META_KEY]`. */
  skillRefs: string[];
}

/** Outcome of a `tools/list` discovery call — never throws. */
export type ListToolsOutcome =
  | { kind: 'ok'; tools: DiscoveredBackendTool[] }
  | { kind: 'unreachable'; message: string };

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

  /**
   * Discover the backend's advertised tools over MCP `tools/list` (Phase 4).
   * Pages through `nextCursor`, reads each tool's skill ref(s) from `_meta`, and
   * NEVER throws — an unreachable backend returns `{ kind: 'unreachable' }` so
   * the caller can hide the tools and keep the skill loadable (EC-11).
   */
  async listTools(timeoutMs: number): Promise<ListToolsOutcome> {
    const sdk = await loadMcpClientSdk();
    const exchange = AbortSignal.timeout(timeoutMs);
    const client: Client = new sdk.Client(CLIENT_INFO);
    const transport: StreamableHTTPClientTransport = new sdk.StreamableHTTPClientTransport(
      new URL(`${this.baseUrl}${this.mcpPath}`),
      {
        fetch: createSigningFetch({
          identity: this.identity,
          signedPath: this.mcpPath,
          // tools/list carries no 005 envelope deadline; the exchange signal
          // bounds it. A far-future deadline keeps the signer's clock-skew check
          // happy without constraining the call.
          deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
          signal: exchange,
        }),
      },
    );

    const tools: DiscoveredBackendTool[] = [];
    try {
      await client.connect(transport, { signal: exchange, timeout: timeoutMs });
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { signal: exchange, timeout: timeoutMs });
        for (const tool of page.tools) {
          tools.push({
            name: tool.name,
            description: typeof tool.description === 'string' ? tool.description : '',
            inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
            skillRefs: extractSkillRefs(tool._meta),
          });
        }
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      } while (cursor);
      return { kind: 'ok', tools };
    } catch (err) {
      return { kind: 'unreachable', message: err instanceof Error ? err.message : 'tools/list failed' };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

/** Read `_meta[SKILL_REFS_META_KEY]` as a string array; tolerant of absence/shape. */
function extractSkillRefs(meta: unknown): string[] {
  if (typeof meta !== 'object' || meta === null) return [];
  const value = (meta as Record<string, unknown>)[SKILL_REFS_META_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

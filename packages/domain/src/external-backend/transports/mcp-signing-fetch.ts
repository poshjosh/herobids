// The fetch middleware the MCP client SDK sends every frame through (Step 10
// plan §2.5; Phase 3 T2.1 gate 1). Each request is signed with the UNMODIFIED
// `signRequest` over the exact body string the SDK serialized, and that same
// string is forwarded — wire bytes = hashed bytes. `sign.ts` stays frozen (I4).
import { signRequest, type SigningIdentity } from '../sign.js';

export interface SigningFetchOptions {
  identity: SigningIdentity;
  /** The path every frame is signed for (the backend's `mcpPath`). */
  signedPath: string;
  /** `X-Request-Deadline-At` for every frame of the exchange (= envelope `deadlineAt`). */
  deadlineAt: string;
  /** Bounds the whole exchange; combined with any per-request signal the SDK passes. */
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

export function createSigningFetch(options: SigningFetchOptions): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (input, init) => {
    const url = requestUrl(input);
    // A redirect target is never signed: the signature binds one path.
    if (url.pathname !== options.signedPath) {
      throw new Error(`mcp signing: refusing to sign a request for ${url.pathname}`);
    }
    const body = init?.body;
    // Gate-1 tripwire: only a string body has bytes we can hash and forward unchanged.
    if (body !== undefined && body !== null && typeof body !== 'string') {
      throw new TypeError('mcp signing: request body must be a string');
    }
    const signed = signRequest(options.identity, {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: options.signedPath,
      rawBody: Buffer.from(body ?? '', 'utf8'),
      deadlineAt: options.deadlineAt,
    });
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(signed)) headers.set(name, value);
    const signal = init?.signal ? AbortSignal.any([init.signal, options.signal]) : options.signal;
    // `init.body` is forwarded untouched: the same string that was hashed.
    return fetchImpl(url, { ...init, headers, signal });
  };
}

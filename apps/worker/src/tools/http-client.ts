import { z } from 'zod';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { capabilityDeniedResult, nonFaultError } from './tool-errors.js';
import { isHostPrivate } from './ssrf-guard.js';

const logger = createLogger('tools:http-client');

// ── Config ──────────────────────────────────────────────────────────────────

const _httpClientConfig = (() => {
  try {
    const raw = process.env['AGENT_RUNTIME_CONFIG_JSON'];
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as {
      tools?: {
        httpClient?: {
          enabled?: boolean;
          maxResponseBytes?: number;
          denyList?: string[];
        };
      };
    };
    return parsed.tools?.httpClient;
  } catch {
    return undefined;
  }
})();

// ── Deny-list matching ──────────────────────────────────────────────────────

export function matchesDenyPattern(hostname: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${regexStr}$`, 'i').test(hostname);
}

export function isHostDenied(hostname: string, denyList: string[]): boolean {
  return denyList.some((pattern) => matchesDenyPattern(hostname, pattern));
}

// ── Tool schema ─────────────────────────────────────────────────────────────

const HttpRequestParamsSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
    .describe('HTTP method'),
  url: z.string().url()
    .describe('Target URL (must be HTTPS for external requests)'),
  headers: z.record(z.string()).optional()
    .describe('Optional HTTP headers as key-value pairs'),
  body: z.string().optional()
    .describe('Optional request body (string). Set Content-Type header appropriately.'),
  timeoutMs: z.coerce.number().int().min(1000).max(30000).optional().default(15000)
    .describe('Request timeout in ms (1000-30000, default 15000)'),
});

type HttpRequestParams = z.infer<typeof HttpRequestParamsSchema>;

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncateBody(body: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(body, 'utf8');
  if (bytes.length <= maxBytes) {
    return { text: body, truncated: false };
  }
  return { text: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

// ── Tool implementation ─────────────────────────────────────────────────────

const httpRequestTool: AgentTool = {
  name: 'make_http_request',
  description:
    'Make structured HTTP requests to external APIs. Supports GET, POST, PUT, PATCH, DELETE, HEAD. ' +
    'Returns status code, response headers, and response body (truncated to configured limit). ' +
    'SSRF-protected: private IPs and deny-listed hostnames are blocked.',
  parametersSchema: HttpRequestParamsSchema,
  parameters: convertZodToJsonSchema(HttpRequestParamsSchema),
  category: 'read-web',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    // Capability gating
    if (ctx.capabilityEngine) {
      const denied = ctx.capabilityEngine.checkAccess('make_http_request', ctx.agentId, ctx.sessionId);
      if (denied) {
        logger.warn({
          agentId: ctx.agentId,
          capability: 'make_http_request',
          reason: denied.reason,
          limit: denied.limit,
          used: denied.used,
          retryAfterMs: denied.retryAfterMs,
        }, 'Capability policy denied');
        return capabilityDeniedResult('make_http_request', denied);
      }
      ctx.capabilityEngine.recordStart('make_http_request', ctx.sessionId);
    }

    // Check enabled flag
    if (_httpClientConfig && _httpClientConfig.enabled === false) {
      return nonFaultError('make_http_request: tool is disabled by operator configuration');
    }

    const startMs = Date.now();
    let requestSuccess = false;
    let errorCode: string | undefined;

    try {
      const parsed = HttpRequestParamsSchema.parse(params);
      return await executeHttpRequest(parsed, ctx, (s, c) => {
        requestSuccess = s;
        errorCode = c;
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      errorCode = 'make_http_request.internal_error';
      return { success: false, error: `make_http_request failed: ${msg}`, retryable: false };
    } finally {
      if (ctx.capabilityEngine) {
        ctx.capabilityEngine.recordEnd('make_http_request', ctx.sessionId, {
          capability: 'make_http_request',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          inputSummary: `${(params as Record<string, unknown>)?.['method'] ?? '?'} ${(params as Record<string, unknown>)?.['url'] ?? '?'}`,
          outputSummary: requestSuccess ? 'ok' : (errorCode ?? 'error'),
          success: requestSuccess,
          errorCode,
        });
      }
    }
  },
};

async function executeHttpRequest(
  parsed: HttpRequestParams,
  ctx: ToolContext,
  report: (success: boolean, errorCode?: string) => void,
): Promise<ToolResult> {
  // Parse URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(parsed.url);
  } catch {
    report(false, 'make_http_request.invalid_url');
    return nonFaultError('make_http_request: invalid URL');
  }

  // Only allow HTTP/HTTPS schemes
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    report(false, 'make_http_request.unsupported_protocol');
    return nonFaultError(`make_http_request: unsupported protocol "${parsedUrl.protocol}"`);
  }

  const hostname = parsedUrl.hostname;

  // Check deny list
  const denyList = _httpClientConfig?.denyList ?? [];
  if (isHostDenied(hostname, denyList)) {
    logger.warn({ agentId: ctx.agentId, hostname }, 'make_http_request blocked by deny list');
    report(false, 'make_http_request.denied');
    return nonFaultError(`make_http_request blocked: hostname "${hostname}" is on the deny list`);
  }

  // SSRF check — resolve DNS and block private IPs
  const isPrivate = await isHostPrivate(hostname);
  if (isPrivate) {
    logger.warn({ agentId: ctx.agentId, hostname }, 'make_http_request blocked private/unresolvable hostname');
    report(false, 'make_http_request.ssrf_blocked');
    return nonFaultError('make_http_request blocked: hostname resolves to a private or reserved IP address');
  }

  // Determine response byte limit
  const grant = ctx.capabilityEngine?.getGrant('make_http_request');
  const maxResponseBytes = grant?.limits?.maxResponseBytes ?? _httpClientConfig?.maxResponseBytes ?? 256 * 1024;
  const effectiveTimeoutMs = grant?.limits?.timeoutMs ?? parsed.timeoutMs;

  // Execute request with manual redirect following to re-validate SSRF on each hop.
  const MAX_REDIRECTS = 5;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), effectiveTimeoutMs);

  try {
    let currentUrl = parsed.url;

    // First request carries the original method, headers, and body.
    // Subsequent redirect-following requests are GET (per HTTP spec for 301/302/303).
    let currentMethod = parsed.method;
    let currentBody = parsed.body && currentMethod !== 'GET' && currentMethod !== 'HEAD'
      ? parsed.body
      : undefined;
    let currentHeaders = parsed.headers;

    let response: Response | undefined;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const fetchInit: RequestInit = {
        method: currentMethod,
        headers: currentHeaders,
        signal: controller.signal,
        redirect: 'manual',  // handle redirects ourselves for SSRF re-validation
      };

      if (currentBody) {
        fetchInit.body = currentBody;
      }

      response = await fetch(currentUrl, fetchInit);

      // Check for redirect (3xx with Location header)
      const isRedirect = response.status >= 300 && response.status < 400;
      const location = response.headers.get('location');

      if (!isRedirect || !location) {
        break; // Not a redirect — proceed with this response
      }

      if (hop === MAX_REDIRECTS) {
        report(false, 'make_http_request.too_many_redirects');
        return nonFaultError(`make_http_request: exceeded maximum of ${MAX_REDIRECTS} redirects`);
      }

      // Resolve the redirect target (may be relative)
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, currentUrl);
      } catch {
        report(false, 'make_http_request.invalid_redirect');
        return nonFaultError(`make_http_request: redirect target is not a valid URL: ${location.slice(0, 200)}`);
      }

      // Re-validate protocol
      if (redirectUrl.protocol !== 'https:' && redirectUrl.protocol !== 'http:') {
        report(false, 'make_http_request.redirect_ssrf_blocked');
        return nonFaultError(`make_http_request: redirect to unsupported protocol "${redirectUrl.protocol}"`);
      }

      // Re-validate deny list
      if (isHostDenied(redirectUrl.hostname, denyList)) {
        logger.warn({ agentId: ctx.agentId, hostname: redirectUrl.hostname, hop }, 'make_http_request redirect blocked by deny list');
        report(false, 'make_http_request.redirect_ssrf_blocked');
        return nonFaultError(`make_http_request: redirect blocked — hostname "${redirectUrl.hostname}" is on the deny list`);
      }

      // Re-validate SSRF via DNS resolution
      const redirectIsPrivate = await isHostPrivate(redirectUrl.hostname);
      if (redirectIsPrivate) {
        logger.warn({ agentId: ctx.agentId, hostname: redirectUrl.hostname, hop }, 'make_http_request redirect blocked — private IP');
        report(false, 'make_http_request.redirect_ssrf_blocked');
        return nonFaultError('make_http_request: redirect blocked — target resolves to a private or reserved IP address');
      }

      // Per HTTP spec: 301/302/303 redirects convert to GET and drop the body.
      // 307/308 preserve the original method and body.
      if (response.status === 307 || response.status === 308) {
        // Preserve method and body
      } else {
        currentMethod = 'GET';
        currentBody = undefined;
        currentHeaders = undefined;
      }

      currentUrl = redirectUrl.href;
    }

    if (!response) {
      report(false, 'make_http_request.fetch_error');
      return nonFaultError('make_http_request: no response received');
    }

    // Collect response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Read body (skip for HEAD)
    let bodyText = '';
    let truncated = false;
    if (parsed.method !== 'HEAD') {
      const rawBody = await response.text();
      const result = truncateBody(rawBody, maxResponseBytes);
      bodyText = result.text;
      truncated = result.truncated;
    }

    report(true);
    return {
      success: true,
      data: {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: bodyText,
        truncated,
      },
    };
  } catch (error: unknown) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError';
    if (isTimeout) {
      report(false, 'make_http_request.timeout');
      return { success: false, error: `make_http_request timed out after ${effectiveTimeoutMs}ms`, retryable: true, fault: false };
    }
    const msg = error instanceof Error ? error.message : String(error);
    report(false, 'make_http_request.fetch_error');
    return nonFaultError(`make_http_request failed: ${msg}`);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export const httpClientTools: AgentTool[] = [httpRequestTool];

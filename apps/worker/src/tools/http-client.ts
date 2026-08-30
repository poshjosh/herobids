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
  name: 'http_request',
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
      const denied = ctx.capabilityEngine.checkAccess('http_request', ctx.agentId, ctx.sessionId);
      if (denied) {
        logger.warn({
          agentId: ctx.agentId,
          capability: 'http_request',
          reason: denied.reason,
          limit: denied.limit,
          used: denied.used,
          retryAfterMs: denied.retryAfterMs,
        }, 'Capability policy denied');
        return capabilityDeniedResult('http_request', denied);
      }
      ctx.capabilityEngine.recordStart('http_request', ctx.sessionId);
    }

    // Check enabled flag
    if (_httpClientConfig && _httpClientConfig.enabled === false) {
      return nonFaultError('http_request: tool is disabled by operator configuration');
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
      errorCode = 'http_request.internal_error';
      return { success: false, error: `http_request failed: ${msg}`, retryable: false };
    } finally {
      if (ctx.capabilityEngine) {
        ctx.capabilityEngine.recordEnd('http_request', ctx.sessionId, {
          capability: 'http_request',
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
    report(false, 'http_request.invalid_url');
    return nonFaultError('http_request: invalid URL');
  }

  // Only allow HTTP/HTTPS schemes
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    report(false, 'http_request.unsupported_protocol');
    return nonFaultError(`http_request: unsupported protocol "${parsedUrl.protocol}"`);
  }

  const hostname = parsedUrl.hostname;

  // Check deny list
  const denyList = _httpClientConfig?.denyList ?? [];
  if (isHostDenied(hostname, denyList)) {
    logger.warn({ agentId: ctx.agentId, hostname }, 'http_request blocked by deny list');
    report(false, 'http_request.denied');
    return nonFaultError(`http_request blocked: hostname "${hostname}" is on the deny list`);
  }

  // SSRF check — resolve DNS and block private IPs
  const isPrivate = await isHostPrivate(hostname);
  if (isPrivate) {
    logger.warn({ agentId: ctx.agentId, hostname }, 'http_request blocked private/unresolvable hostname');
    report(false, 'http_request.ssrf_blocked');
    return nonFaultError('http_request blocked: hostname resolves to a private or reserved IP address');
  }

  // Determine response byte limit
  const grant = ctx.capabilityEngine?.getGrant('http_request');
  const maxResponseBytes = grant?.limits?.maxResponseBytes ?? _httpClientConfig?.maxResponseBytes ?? 256 * 1024;
  const effectiveTimeoutMs = grant?.limits?.timeoutMs ?? parsed.timeoutMs;

  // Execute request
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), effectiveTimeoutMs);

  try {
    const fetchInit: RequestInit = {
      method: parsed.method,
      headers: parsed.headers,
      signal: controller.signal,
      redirect: 'follow',
    };

    // Only attach body for methods that support it
    if (parsed.body && parsed.method !== 'GET' && parsed.method !== 'HEAD') {
      fetchInit.body = parsed.body;
    }

    const response = await fetch(parsed.url, fetchInit);

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
      report(false, 'http_request.timeout');
      return { success: false, error: `http_request timed out after ${effectiveTimeoutMs}ms`, retryable: true, fault: false };
    }
    const msg = error instanceof Error ? error.message : String(error);
    report(false, 'http_request.fetch_error');
    return nonFaultError(`http_request failed: ${msg}`);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export const httpClientTools: AgentTool[] = [httpRequestTool];

import { createRequire } from 'node:module';
import { resolve4, resolve6 } from 'node:dns/promises';
import { z } from 'zod';
import { parseHTML } from 'linkedom';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { PdfTextExtractor } from '@herobids/documents/document-text-extractors';

// @mozilla/readability is CJS-only — use createRequire to load from ESM.
const _require = createRequire(import.meta.url);
const { Readability } = _require('@mozilla/readability') as { Readability: new (doc: Document) => { parse(): { title: string; textContent: string } | null } };

const logger = createLogger('tools:web-access');

const pdfExtractor = new PdfTextExtractor();

function nonFaultError(error: string, retryable = false): ToolResult {
  return { success: false, error, retryable, fault: false };
}

function getJsonSizeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateUtf8ByBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return bytes.slice(0, maxBytes).toString('utf8');
}

function fitQueryToBudget(
  query: string,
  maxBytes: number,
  buildEnvelope: (candidateQuery: string) => unknown,
): string | null {
  if (getJsonSizeBytes(buildEnvelope('')) > maxBytes) {
    return null;
  }
  if (getJsonSizeBytes(buildEnvelope(query)) <= maxBytes) {
    return query;
  }

  const queryBytes = Buffer.byteLength(query, 'utf8');
  let low = 0;
  let high = queryBytes;
  let best = '';

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = truncateUtf8ByBytes(query, mid);
    if (getJsonSizeBytes(buildEnvelope(candidate)) <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function buildSearchWebResponse(
  query: string,
  results: Array<{ title: string; url: string; snippet: string; score: number }>,
  maxBytes: number,
): { ok: true; query: string; results: Array<{ title: string; url: string; snippet: string; score: number }>; truncated?: true } | null {
  const fullResponse = { ok: true as const, query, results };
  if (getJsonSizeBytes(fullResponse) <= maxBytes) {
    return fullResponse;
  }

  const snippetTrimmedResults = results.map((result) => ({
    ...result,
    snippet: result.snippet.slice(0, 200),
  }));
  const snippetTrimmedResponse = {
    ok: true as const,
    query,
    results: snippetTrimmedResults,
    truncated: true as const,
  };
  if (getJsonSizeBytes(snippetTrimmedResponse) <= maxBytes) {
    return snippetTrimmedResponse;
  }

  const fallbackBase = {
    ok: true as const,
    query: '',
    results: [] as Array<{ title: string; url: string; snippet: string; score: number }>,
    truncated: true as const,
  };
  const fittedQuery = fitQueryToBudget(query, maxBytes, (candidateQuery) => ({
    ...fallbackBase,
    query: candidateQuery,
  }));
  if (fittedQuery === null) {
    return null;
  }

  return {
    ...fallbackBase,
    query: fittedQuery,
  };
}

function isSupportedBrowseContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const normalized = contentType.toLowerCase();
  return normalized.startsWith('text/html') || normalized.startsWith('application/xhtml+xml');
}

// Read webAccess config from AGENT_RUNTIME_CONFIG_JSON injected by the worker.
const _runtimeConfig = (() => {
  try {
    const raw = process.env['AGENT_RUNTIME_CONFIG_JSON'];
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as {
      tools?: {
        webAccess?: {
          tavily?: { baseUrl?: string; searchDepth?: string; maxResults?: number; timeoutMs?: number };
          browseUrl?: { maxResponseBytes?: number; timeoutMs?: number; maxRedirects?: number };
        };
      };
    };
    return parsed.tools?.webAccess;
  } catch {
    return undefined;
  }
})();

// --- SSRF prevention ---

// RFC 1918 + loopback + link-local CIDR ranges blocked for browse_url.
const PRIVATE_RANGES: Array<{ prefix: number[]; bits: number }> = [
  { prefix: [10], bits: 8 },
  { prefix: [172, 16], bits: 12 },
  { prefix: [192, 168], bits: 16 },
  { prefix: [127], bits: 8 },
  { prefix: [169, 254], bits: 16 },
  { prefix: [100, 64], bits: 10 }, // Shared address space (RFC 6598)
  { prefix: [0], bits: 8 },         // "This" network
  { prefix: [240], bits: 4 },       // Reserved
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  for (const range of PRIVATE_RANGES) {
    const mask = ~((1 << (32 - range.bits)) - 1) >>> 0;
    const base = ipv4ToInt(range.prefix.concat(Array(4 - range.prefix.length).fill(0)).join('.'));
    if ((ipInt & mask) === (base & mask)) return true;
  }
  return false;
}

const PRIVATE_IPV6_PREFIXES = ['::1', 'fe80:', 'fc', 'fd'];

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) — extract the IPv4 part and check it
  const ipv4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Mapped?.[1]) {
    return isPrivateIpv4(ipv4Mapped[1]);
  }
  return PRIVATE_IPV6_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(prefix));
}

async function isHostPrivate(hostname: string): Promise<boolean> {
  // If the hostname is a raw IPv4 literal, check it directly without DNS.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return isPrivateIpv4(hostname);
  }
  // If the hostname is a raw IPv6 literal (with or without brackets), check directly.
  const ipv6Literal = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (ipv6Literal.includes(':')) {
    return isPrivateIpv6(ipv6Literal);
  }

  const results: string[] = [];
  try {
    const v4 = await resolve4(hostname);
    results.push(...v4);
  } catch {
    // hostname may not have A records
  }
  try {
    const v6 = await resolve6(hostname);
    results.push(...v6);
  } catch {
    // hostname may not have AAAA records
  }
  if (results.length === 0) {
    // Cannot resolve hostname — block as a safety measure
    return true;
  }
  return results.some((ip) => (ip.includes(':') ? isPrivateIpv6(ip) : isPrivateIpv4(ip)));
}

// --- search_web ---

const WebSearchParamsSchema = z.object({
  query: z.string().min(1).max(400).describe('Search query string'),
  // coerce: LLMs may send numbers as strings
  maxResults: z.coerce.number().int().min(1).max(10).optional().describe('Maximum number of results to return (1-10)'),
});

const webSearchTool: AgentTool = {
  name: 'search_web',
  description: 'Search the internet using Tavily. Returns top results with titles, URLs, and text extracts. Requires TAVILY_API_KEY.',
  parametersSchema: WebSearchParamsSchema,
  parameters: convertZodToJsonSchema(WebSearchParamsSchema),
  category: 'read-web',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.capabilityEngine) {
      const denied = ctx.capabilityEngine.checkAccess('search_web', ctx.agentId, ctx.sessionId);
      if (denied) {
        logger.warn({ agentId: ctx.agentId, reason: denied }, 'search_web denied by capability policy');
        return nonFaultError(denied.message);
      }
      ctx.capabilityEngine.recordStart('search_web', ctx.sessionId);
    }

    const startMs = Date.now();
    let searchSuccess = false;

    try {
      const apiKey = process.env['TAVILY_API_KEY'];
      if (!apiKey) {
        return { success: false, error: 'search_web requires TAVILY_API_KEY', retryable: false, fault: false };
      }

      const { query, maxResults } = params as z.infer<typeof WebSearchParamsSchema>;
      const tavilyConfig = _runtimeConfig?.tavily;
      const baseUrl = tavilyConfig?.baseUrl ?? 'https://api.tavily.com';
      const searchDepth = tavilyConfig?.searchDepth ?? 'basic';
      const configMaxResults = tavilyConfig?.maxResults ?? 5;
      const timeoutMs = tavilyConfig?.timeoutMs ?? 15_000;

      const grant = ctx.capabilityEngine?.getGrant('search_web');
      const maxResponseBytes = grant?.limits?.maxResponseBytes ?? _runtimeConfig?.browseUrl?.maxResponseBytes ?? 256 * 1024;
      const effectiveTimeoutMs = grant?.limits?.timeoutMs ?? timeoutMs;
      const effectiveMaxResults = maxResults ?? configMaxResults;

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), effectiveTimeoutMs);

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            search_depth: searchDepth,
            max_results: effectiveMaxResults,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        logger.warn({ agentId: ctx.agentId, status: response.status }, 'search_web Tavily request failed');
        return { success: false, error: `Tavily API error: ${response.status} ${errText.slice(0, 200)}`, retryable: response.status >= 500, fault: response.status >= 500 };
      }

      const json = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string; score?: number }> };
      const results = (json.results ?? []).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.content ?? '',
        score: r.score ?? 0,
      }));

      const data = buildSearchWebResponse(query, results, maxResponseBytes);
      if (!data) {
        return {
          success: false,
          error: `search_web response could not fit within maxResponseBytes (${maxResponseBytes})`,
          retryable: false,
          fault: false,
        };
      }

      searchSuccess = true;
      return { success: true, data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes('abort') || msg.includes('timeout');
      logger.warn({ agentId: ctx.agentId, error: msg }, 'search_web failed');
      return { success: false, error: `search_web failed: ${msg}`, retryable: isTimeout, fault: isTimeout ? undefined : false };
    } finally {
      if (ctx.capabilityEngine) {
        ctx.capabilityEngine.recordEnd('search_web', ctx.sessionId, {
          capability: 'search_web',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          inputSummary: `query=${((params as Record<string, unknown>)['query'] ?? '').toString().slice(0, 80)}`,
          outputSummary: searchSuccess ? 'results returned' : 'error',
          success: searchSuccess,
        });
      }
    }
  },
};

// --- browse_url ---

const BrowseUrlParamsSchema = z.object({
  url: z.string().url().describe('Full HTTPS URL to fetch (e.g. "https://example.com/page")'),
});

const browseUrlTool: AgentTool = {
  name: 'browse_url',
  description: 'Fetch and read the contents of a web page. Only https:// URLs are allowed. Private IP addresses and loopback are blocked.',
  parametersSchema: BrowseUrlParamsSchema,
  parameters: convertZodToJsonSchema(BrowseUrlParamsSchema),
  category: 'read-web',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.capabilityEngine) {
      const denied = ctx.capabilityEngine.checkAccess('browse_url', ctx.agentId, ctx.sessionId);
      if (denied) {
        logger.warn({ agentId: ctx.agentId, reason: denied }, 'browse_url denied by capability policy');
        return nonFaultError(denied.message);
      }
      ctx.capabilityEngine.recordStart('browse_url', ctx.sessionId);
    }

    const startMs = Date.now();
    let browseSuccess = false;

    try {
      const { url } = params as z.infer<typeof BrowseUrlParamsSchema>;

      // Enforce HTTPS
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        return nonFaultError('browse_url only allows https:// URLs');
      }

      // SSRF: resolve hostname and block private IPs
      const hostname = parsed.hostname;
      const isPrivate = await isHostPrivate(hostname);
      if (isPrivate) {
        logger.warn({ agentId: ctx.agentId, hostname }, 'browse_url blocked private/unresolvable hostname');
        return nonFaultError('browse_url blocked: hostname resolves to a private or reserved IP address');
      }

      const browseConfig = _runtimeConfig?.browseUrl;
      const grant = ctx.capabilityEngine?.getGrant('browse_url');
      const maxResponseBytes = grant?.limits?.maxResponseBytes ?? browseConfig?.maxResponseBytes ?? 512 * 1024;
      const timeoutMs = grant?.limits?.timeoutMs ?? browseConfig?.timeoutMs ?? 15_000;
      const maxRedirects = browseConfig?.maxRedirects ?? 3;

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      let currentUrl = url;
      try {
        // Follow redirects up to maxRedirects hops, re-validating SSRF on each hop.
        let hops = 0;
        while (true) {
          response = await fetch(currentUrl, {
            headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'User-Agent': 'OpenAIdom-Agent/1.0' },
            redirect: 'manual',
            signal: controller.signal,
          });

          if (response.status < 300 || response.status >= 400) break;

          // Have a redirect — check if we can follow it.
          if (hops >= maxRedirects) {
            return nonFaultError(`browse_url: too many redirects (limit ${maxRedirects})`);
          }

          const location = response.headers.get('location');
          if (!location) {
            return nonFaultError(`browse_url blocked HTTP redirect (${response.status}): no Location header`);
          }

          let dest: URL;
          try {
            dest = new URL(location, currentUrl);
          } catch {
            return nonFaultError(`browse_url blocked redirect: invalid Location URL '${location}'`);
          }

          // Only follow HTTPS redirects.
          if (dest.protocol !== 'https:') {
            return nonFaultError(`browse_url blocked redirect to non-HTTPS URL: ${dest.toString()}`);
          }

          // Re-check SSRF on destination hostname.
          if (await isHostPrivate(dest.hostname)) {
            logger.warn({ agentId: ctx.agentId, hostname: dest.hostname }, 'browse_url blocked redirect to private/unresolvable hostname');
            return nonFaultError(`browse_url blocked redirect: hostname '${dest.hostname}' resolves to a private or reserved IP address`);
          }

          currentUrl = dest.toString();
          hops++;
        }
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (response.status >= 300 && response.status < 400) {
        // Should not reach here — handled in the loop — but guard defensively.
        const location = response.headers.get('location');
        return nonFaultError(
          location
            ? `browse_url blocked redirect to ${location}`
            : `browse_url blocked HTTP redirect (${response.status})`,
        );
      }

      if (!response.ok) {
        // 4xx: content-level failure (page not found, auth required, etc.) — not a tool fault.
        // 5xx: server error — ambiguous, but still not the tool's fault.
        return nonFaultError(`browse_url HTTP error: ${response.status}`, response.status >= 500);
      }

      const contentType = response.headers.get('content-type');
      if (!isSupportedBrowseContentType(contentType)) {
        return nonFaultError(`browse_url unsupported content type: ${contentType}`);
      }

      // Abort early if Content-Length header already exceeds the byte cap
      const contentLength = Number(response.headers.get('content-length') ?? NaN);
      if (!Number.isNaN(contentLength) && contentLength > maxResponseBytes) {
        logger.warn({ agentId: ctx.agentId, contentLength, maxResponseBytes }, 'browse_url: Content-Length exceeds limit, aborting before stream');
        controller.abort();
        return nonFaultError(`browse_url blocked: Content-Length (${contentLength}) exceeds maxResponseBytes (${maxResponseBytes})`);
      }

      // Stream body with byte cap to avoid buffering huge responses
      const reader = response.body?.getReader();
      if (!reader) {
        return nonFaultError('browse_url: no response body');
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let truncated = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          if (totalBytes + value.length > maxResponseBytes) {
            const remaining = maxResponseBytes - totalBytes;
            chunks.push(value.slice(0, remaining));
            totalBytes += remaining;
            truncated = true;
            break;
          }
          chunks.push(value);
          totalBytes += value.length;
        }
      }
      reader.cancel().catch(() => undefined);

      const bodyText = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');

      // Extract readable text via @mozilla/readability + linkedom
      let title = currentUrl;
      let content = bodyText;

      try {
        const { document } = parseHTML(bodyText);
        // Attempt readability extraction
        const reader2 = new Readability(document as unknown as Document);
        const article = reader2.parse();
        if (article) {
          title = article.title || currentUrl;
          content = article.textContent ?? bodyText;
        } else {
          // Fall back to body text content
          const bodyEl = document.querySelector('body');
          content = bodyEl ? bodyEl.textContent ?? bodyText : bodyText;
          const titleEl = document.querySelector('title');
          title = titleEl ? titleEl.textContent ?? currentUrl : currentUrl;
        }
      } catch {
        // Parsing failed — return raw body text truncated
        content = bodyText;
      }

      // Final truncation of text content to maxResponseBytes
      const contentBytes = Buffer.byteLength(content, 'utf8');
      if (contentBytes > maxResponseBytes) {
        content = Buffer.from(content, 'utf8').slice(0, maxResponseBytes).toString('utf8');
        truncated = true;
      }

      browseSuccess = true;
  return { success: true, data: { url: currentUrl, title, content, truncated } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes('abort') || msg.includes('timeout');
      logger.warn({ agentId: ctx.agentId, error: msg }, 'browse_url failed');
      return { success: false, error: `browse_url failed: ${msg}`, retryable: isTimeout, fault: isTimeout ? undefined : false };
    } finally {
      if (ctx.capabilityEngine) {
        ctx.capabilityEngine.recordEnd('browse_url', ctx.sessionId, {
          capability: 'browse_url',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          inputSummary: `url=${((params as Record<string, unknown>)['url'] ?? '').toString().slice(0, 100)}`,
          outputSummary: browseSuccess ? 'content extracted' : 'error',
          success: browseSuccess,
        });
      }
    }
  },
};

// --- read_document ---

function isSupportedDocumentContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase().split(';')[0]!.trim();
  return normalized === 'application/pdf';
}

const ReadDocumentParamsSchema = z.object({
  url: z.string().url().describe('Full HTTPS URL of the document to read (e.g. PDF)'),
});

const readDocumentTool: AgentTool = {
  name: 'read_document',
  description: 'Fetch and extract text from a document URL (currently supports PDF). Only https:// URLs are allowed. Private IP addresses and loopback are blocked.',
  parametersSchema: ReadDocumentParamsSchema,
  parameters: convertZodToJsonSchema(ReadDocumentParamsSchema),
  category: 'read-web',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.capabilityEngine) {
      const denied = ctx.capabilityEngine.checkAccess('read_document', ctx.agentId, ctx.sessionId);
      if (denied) {
        logger.warn({ agentId: ctx.agentId, reason: denied }, 'read_document denied by capability policy');
        return nonFaultError(denied.message);
      }
      ctx.capabilityEngine.recordStart('read_document', ctx.sessionId);
    }

    const startMs = Date.now();
    let docSuccess = false;

    try {
      const { url } = params as z.infer<typeof ReadDocumentParamsSchema>;

      // Enforce HTTPS
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        return nonFaultError('read_document only allows https:// URLs');
      }

      // SSRF: resolve hostname and block private IPs
      const hostname = parsed.hostname;
      const isPrivate = await isHostPrivate(hostname);
      if (isPrivate) {
        logger.warn({ agentId: ctx.agentId, hostname }, 'read_document blocked private/unresolvable hostname');
        return nonFaultError('read_document blocked: hostname resolves to a private or reserved IP address');
      }

      const browseConfig = _runtimeConfig?.browseUrl;
      const grant = ctx.capabilityEngine?.getGrant('read_document');
      const maxResponseBytes = grant?.limits?.maxResponseBytes ?? browseConfig?.maxResponseBytes ?? 512 * 1024;
      const timeoutMs = grant?.limits?.timeoutMs ?? browseConfig?.timeoutMs ?? 15_000;

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(url, {
          headers: { 'Accept': 'application/pdf,*/*;q=0.8', 'User-Agent': 'OpenAIdom-Agent/1.0' },
          redirect: 'manual',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (response.status >= 300 && response.status < 400) {
        return nonFaultError(`read_document blocked redirect (${response.status})`);
      }

      if (!response.ok) {
        return nonFaultError(`read_document HTTP error: ${response.status}`, response.status >= 500);
      }

      const contentType = response.headers.get('content-type');
      if (!isSupportedDocumentContentType(contentType)) {
        return nonFaultError(`read_document unsupported content type: ${contentType ?? 'unknown'}. Only PDF is supported.`);
      }

      // Abort early if Content-Length exceeds byte cap
      const contentLength = Number(response.headers.get('content-length') ?? NaN);
      if (!Number.isNaN(contentLength) && contentLength > maxResponseBytes) {
        controller.abort();
        return nonFaultError(`read_document blocked: Content-Length (${contentLength}) exceeds maxResponseBytes (${maxResponseBytes})`);
      }

      // Stream body with byte cap
      const reader = response.body?.getReader();
      if (!reader) {
        return nonFaultError('read_document: no response body');
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let truncated = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          if (totalBytes + value.length > maxResponseBytes) {
            const remaining = maxResponseBytes - totalBytes;
            chunks.push(value.slice(0, remaining));
            totalBytes += remaining;
            truncated = true;
            break;
          }
          chunks.push(value);
          totalBytes += value.length;
        }
      }
      reader.cancel().catch(() => undefined);

      const pdfBuffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));

      // Delegate to the shared PdfTextExtractor. It returns a Result — on
      // failure we still report success (document was fetched) but with empty text.
      let text = '';
      let extractionTruncated = false;
      try {
        const extractionResult = await pdfExtractor.extract({
          body: pdfBuffer,
          mimeType: 'application/pdf',
          filename: url,
        });
        if (extractionResult.ok) {
          text = extractionResult.data.extractedText;
          extractionTruncated = extractionResult.data.truncated;
        } else {
          logger.warn(
            { agentId: ctx.agentId, extractionError: extractionResult.error.code },
            'read_document PDF text extraction failed, returning empty text',
          );
        }
      } catch (extractionErr) {
        // Defensive: PdfTextExtractor.extract() should never throw (it returns
        // Result), but guard against unexpected failures (e.g. dynamic import
        // of pdf-parse failing in constrained runtimes).
        logger.warn(
          {
            agentId: ctx.agentId,
            extractionError: extractionErr instanceof Error ? extractionErr.message : String(extractionErr),
          },
          'read_document PDF text extraction threw, returning empty text',
        );
      }

      docSuccess = true;
      return {
        success: true,
        data: {
          url,
          contentType: 'application/pdf',
          text,
          truncated: truncated || extractionTruncated,
          sizeBytes: totalBytes,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes('abort') || msg.includes('timeout');
      logger.warn({ agentId: ctx.agentId, error: msg }, 'read_document failed');
      return { success: false, error: `read_document failed: ${msg}`, retryable: isTimeout, fault: isTimeout ? undefined : false };
    } finally {
      if (ctx.capabilityEngine) {
        ctx.capabilityEngine.recordEnd('read_document', ctx.sessionId, {
          capability: 'read_document',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          inputSummary: `url=${((params as Record<string, unknown>)['url'] ?? '').toString().slice(0, 100)}`,
          outputSummary: docSuccess ? 'text extracted' : 'error',
          success: docSuccess,
        });
      }
    }
  },
};



export const webAccessTools: AgentTool[] = [webSearchTool, browseUrlTool, readDocumentTool];

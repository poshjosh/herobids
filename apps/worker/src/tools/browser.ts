import { z } from 'zod';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolResult, ToolContext, BrowserPoolPort } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { capabilityDeniedResult, nonFaultError } from './tool-errors.js';
import { isHostPrivate } from './ssrf-guard.js';

const logger = createLogger('tools:browser');

const CDP_COMMAND_TIMEOUT_MS = 10_000;

// ── CDP client ──────────────────────────────────────────────────────────────

interface CdpResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
}

type CdpMessage = CdpResponse | CdpEvent;

function isCdpResponse(msg: CdpMessage): msg is CdpResponse {
  return 'id' in msg;
}

class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  async connect(endpoint: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(endpoint);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('CDP WebSocket connection timed out'));
      }, CDP_COMMAND_TIMEOUT_MS);

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        this.ws = ws;
        resolve();
      });

      ws.addEventListener('error', (event) => {
        clearTimeout(timeout);
        reject(new Error(`CDP WebSocket error: ${String(event)}`));
      });

      ws.addEventListener('close', () => {
        this.rejectAllPending('WebSocket closed');
        this.ws = null;
      });

      ws.addEventListener('message', (event) => {
        try {
          const data = typeof event.data === 'string' ? event.data : String(event.data);
          const msg = JSON.parse(data) as CdpMessage;
          if (isCdpResponse(msg)) {
            const entry = this.pending.get(msg.id);
            if (entry) {
              clearTimeout(entry.timer);
              this.pending.delete(msg.id);
              if (msg.error) {
                entry.reject(new Error(`CDP error: ${msg.error.message} (code ${msg.error.code})`));
              } else {
                entry.resolve(msg.result ?? {});
              }
            }
          }
        } catch {
          // Ignore malformed messages
        }
      });
    });
  }

  async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP WebSocket not connected');
    }
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command '${method}' timed out after ${CDP_COMMAND_TIMEOUT_MS}ms`));
      }, CDP_COMMAND_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.rejectAllPending('Client closed');
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}

// ── Session tracking ────────────────────────────────────────────────────────

interface ActiveSession {
  cdp: CdpClient;
  browserSessionId: string;
  browserPool: BrowserPoolPort;
}

// Key: `${agentId}:${sessionId}`
const activeSessions = new Map<string, ActiveSession>();

function sessionKey(ctx: ToolContext): string {
  return `${ctx.agentId}:${ctx.sessionId}`;
}

// ── Tool schema ─────────────────────────────────────────────────────────────

const BrowseInteractiveParamsSchema = z.object({
  action: z.enum(['open', 'snapshot', 'click', 'fill', 'screenshot', 'get_text', 'close'])
    .describe('Browser action to perform'),
  url: z.string().url().optional()
    .describe('URL to navigate to (required for "open" action)'),
  selector: z.string().optional()
    .describe('CSS selector targeting an element (required for "click", "fill", "get_text")'),
  value: z.string().optional()
    .describe('Value to fill into the element (required for "fill" action)'),
  waitFor: z.string().optional()
    .describe('Optional CSS selector to wait for after navigation or click'),
});

type BrowseParams = z.infer<typeof BrowseInteractiveParamsSchema>;

// ── Action handlers ─────────────────────────────────────────────────────────

async function handleOpen(
  params: BrowseParams,
  ctx: ToolContext,
  browserPool: BrowserPoolPort,
): Promise<ToolResult> {
  if (!params.url) {
    return nonFaultError('browse_interactive: "url" is required for action "open"');
  }

  // SSRF protection
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    return nonFaultError('browse_interactive: invalid URL');
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return nonFaultError(`browse_interactive: unsupported protocol "${parsedUrl.protocol}"`);
  }
  const isPrivate = await isHostPrivate(parsedUrl.hostname);
  if (isPrivate) {
    return nonFaultError('browse_interactive: blocked — hostname resolves to a private or reserved IP address');
  }

  const key = sessionKey(ctx);
  const existing = activeSessions.get(key);
  if (existing) {
    // Re-use existing session — navigate to new URL
    try {
      await existing.cdp.send('Page.navigate', { url: params.url });
      // Wait for page load via a simple polling approach
      await waitForLoad(existing.cdp, params.waitFor);
      return { success: true, data: { message: `Navigated to ${params.url}`, sessionActive: true } };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return nonFaultError(`browse_interactive open failed: ${msg}`);
    }
  }

  // Acquire new session
  const sessionResult = await browserPool.acquireSession();
  if (!sessionResult.ok) {
    return {
      success: false,
      error: `browse_interactive: ${sessionResult.error.message}`,
      errorCode: sessionResult.error.code,
      retryable: sessionResult.error.code === 'browser_pool.timeout' || sessionResult.error.code === 'browser_pool.queue_full',
      fault: false,
    };
  }

  const cdp = new CdpClient();
  try {
    await cdp.connect(sessionResult.data.cdpEndpoint);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: params.url });
    await waitForLoad(cdp, params.waitFor);

    activeSessions.set(key, {
      cdp,
      browserSessionId: sessionResult.data.sessionId,
      browserPool,
    });

    return { success: true, data: { message: `Opened ${params.url}`, sessionActive: true } };
  } catch (error: unknown) {
    cdp.close();
    await browserPool.releaseSession(sessionResult.data.sessionId);
    const msg = error instanceof Error ? error.message : String(error);
    return nonFaultError(`browse_interactive open failed: ${msg}`);
  }
}

async function waitForLoad(cdp: CdpClient, waitForSelector?: string): Promise<void> {
  // Give the page a moment to settle after navigation
  await sleep(500);

  if (waitForSelector) {
    // Poll for the selector to appear (up to 5 seconds)
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `!!document.querySelector(${JSON.stringify(waitForSelector)})`,
        returnByValue: true,
      });
      const value = (result['result'] as Record<string, unknown> | undefined)?.['value'];
      if (value === true) return;
      await sleep(250);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requireSession(ctx: ToolContext): Promise<ActiveSession | ToolResult> {
  const session = activeSessions.get(sessionKey(ctx));
  if (!session) {
    return nonFaultError('browse_interactive: no active session. Call action "open" first.');
  }
  return session;
}

function isToolResult(v: ActiveSession | ToolResult): v is ToolResult {
  return 'success' in v;
}

async function handleSnapshot(ctx: ToolContext): Promise<ToolResult> {
  const sessionOrError = await requireSession(ctx);
  if (isToolResult(sessionOrError)) return sessionOrError;

  try {
    // Try accessibility tree first
    const result = await sessionOrError.cdp.send('Accessibility.getFullAXTree');
    const nodes = result['nodes'] as Array<Record<string, unknown>> | undefined;
    if (nodes && nodes.length > 0) {
      const text = formatAccessibilityTree(nodes);
      return { success: true, data: { snapshot: text, nodeCount: nodes.length } };
    }

    // Fallback: get document text via Runtime.evaluate
    const bodyResult = await sessionOrError.cdp.send('Runtime.evaluate', {
      expression: 'document.body?.innerText?.slice(0, 50000) ?? ""',
      returnByValue: true,
    });
    const bodyText = (bodyResult['result'] as Record<string, unknown> | undefined)?.['value'] as string | undefined;
    return { success: true, data: { snapshot: bodyText ?? '', fallback: true } };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return nonFaultError(`browse_interactive snapshot failed: ${msg}`);
  }
}

function formatAccessibilityTree(nodes: Array<Record<string, unknown>>): string {
  const lines: string[] = [];
  const maxNodes = 200; // Limit output size
  let count = 0;
  for (const node of nodes) {
    if (count >= maxNodes) {
      lines.push(`... (${nodes.length - maxNodes} more nodes)`);
      break;
    }
    const role = (node['role'] as Record<string, unknown> | undefined)?.['value'] ?? 'unknown';
    const name = (node['name'] as Record<string, unknown> | undefined)?.['value'] ?? '';
    const desc = (node['description'] as Record<string, unknown> | undefined)?.['value'] ?? '';
    const nameStr = name ? ` "${name}"` : '';
    const descStr = desc ? ` (${desc})` : '';
    lines.push(`[${role}]${nameStr}${descStr}`);
    count++;
  }
  return lines.join('\n');
}

async function handleClick(params: BrowseParams, ctx: ToolContext): Promise<ToolResult> {
  if (!params.selector) {
    return nonFaultError('browse_interactive: "selector" is required for action "click"');
  }
  const sessionOrError = await requireSession(ctx);
  if (isToolResult(sessionOrError)) return sessionOrError;

  try {
    const result = await sessionOrError.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return { ok: false, error: 'Element not found' };
        el.click();
        return { ok: true };
      })()`,
      returnByValue: true,
    });
    const value = (result['result'] as Record<string, unknown> | undefined)?.['value'] as Record<string, unknown> | undefined;
    if (value?.['ok'] !== true) {
      return nonFaultError(`browse_interactive click: ${(value?.['error'] as string) ?? 'element not found'}`);
    }

    if (params.waitFor) {
      await waitForLoad(sessionOrError.cdp, params.waitFor);
    }

    return { success: true, data: { clicked: params.selector } };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return nonFaultError(`browse_interactive click failed: ${msg}`);
  }
}

async function handleFill(params: BrowseParams, ctx: ToolContext): Promise<ToolResult> {
  if (!params.selector) {
    return nonFaultError('browse_interactive: "selector" is required for action "fill"');
  }
  if (params.value === undefined) {
    return nonFaultError('browse_interactive: "value" is required for action "fill"');
  }
  const sessionOrError = await requireSession(ctx);
  if (isToolResult(sessionOrError)) return sessionOrError;

  try {
    const result = await sessionOrError.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return { ok: false, error: 'Element not found' };
        el.value = ${JSON.stringify(params.value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      })()`,
      returnByValue: true,
    });
    const value = (result['result'] as Record<string, unknown> | undefined)?.['value'] as Record<string, unknown> | undefined;
    if (value?.['ok'] !== true) {
      return nonFaultError(`browse_interactive fill: ${(value?.['error'] as string) ?? 'element not found'}`);
    }
    return { success: true, data: { filled: params.selector, value: params.value } };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return nonFaultError(`browse_interactive fill failed: ${msg}`);
  }
}

async function handleScreenshot(ctx: ToolContext): Promise<ToolResult> {
  const sessionOrError = await requireSession(ctx);
  if (isToolResult(sessionOrError)) return sessionOrError;

  try {
    const result = await sessionOrError.cdp.send('Page.captureScreenshot', { format: 'png' });
    const data = result['data'] as string | undefined;
    if (!data) {
      return nonFaultError('browse_interactive screenshot: no image data returned');
    }
    return { success: true, data: { screenshot: data, format: 'png', encoding: 'base64' } };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return nonFaultError(`browse_interactive screenshot failed: ${msg}`);
  }
}

async function handleGetText(params: BrowseParams, ctx: ToolContext): Promise<ToolResult> {
  if (!params.selector) {
    return nonFaultError('browse_interactive: "selector" is required for action "get_text"');
  }
  const sessionOrError = await requireSession(ctx);
  if (isToolResult(sessionOrError)) return sessionOrError;

  try {
    const result = await sessionOrError.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return { ok: false, error: 'Element not found' };
        return { ok: true, text: el.textContent ?? '' };
      })()`,
      returnByValue: true,
    });
    const value = (result['result'] as Record<string, unknown> | undefined)?.['value'] as Record<string, unknown> | undefined;
    if (value?.['ok'] !== true) {
      return nonFaultError(`browse_interactive get_text: ${(value?.['error'] as string) ?? 'element not found'}`);
    }
    const text = (value['text'] as string).slice(0, 50_000);
    return { success: true, data: { text, selector: params.selector, truncated: text.length >= 50_000 } };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return nonFaultError(`browse_interactive get_text failed: ${msg}`);
  }
}

async function handleClose(ctx: ToolContext): Promise<ToolResult> {
  const key = sessionKey(ctx);
  const session = activeSessions.get(key);
  if (!session) {
    return { success: true, data: { message: 'No active session to close' } };
  }

  session.cdp.close();
  await session.browserPool.releaseSession(session.browserSessionId);
  activeSessions.delete(key);
  return { success: true, data: { message: 'Browser session closed' } };
}

/** Clean up any active browser sessions for the given agent. Call on agent session teardown. */
export async function cleanupBrowserSessions(agentId: string): Promise<void> {
  const keysToDelete: string[] = [];
  for (const [key, session] of activeSessions) {
    if (key.startsWith(`${agentId}:`)) {
      session.cdp.close();
      await session.browserPool.releaseSession(session.browserSessionId);
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    activeSessions.delete(key);
  }
}

// ── Tool factory ────────────────────────────────────────────────────────────

export function createBrowserTools(browserPool: BrowserPoolPort | undefined): AgentTool[] {
  const browseInteractiveTool: AgentTool = {
    name: 'browse_interactive',
    description:
      'Interactive browser automation: open pages, click elements, fill forms, take screenshots, and read accessibility trees. ' +
      'Actions: open (navigate to URL), snapshot (get accessibility tree), click (click element by CSS selector), ' +
      'fill (fill form field by CSS selector), screenshot (capture page as base64 PNG), get_text (read element text), ' +
      'close (release browser session). Call "open" first to start a session.',
    parametersSchema: BrowseInteractiveParamsSchema,
    parameters: convertZodToJsonSchema(BrowseInteractiveParamsSchema),
    category: 'read-web',
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      // Capability gating
      if (ctx.capabilityEngine) {
        const denied = ctx.capabilityEngine.checkAccess('browse_interactive', ctx.agentId, ctx.sessionId);
        if (denied) {
          logger.warn({
            agentId: ctx.agentId,
            capability: 'browse_interactive',
            reason: denied.reason,
            limit: denied.limit,
            used: denied.used,
            retryAfterMs: denied.retryAfterMs,
          }, 'Capability policy denied');
          return capabilityDeniedResult('browse_interactive', denied);
        }
        ctx.capabilityEngine.recordStart('browse_interactive', ctx.sessionId);
      }

      const startMs = Date.now();
      let actionSuccess = false;
      let errorCode: string | undefined;

      try {
        if (!browserPool) {
          return nonFaultError('browse_interactive: browser pool not configured');
        }

        const parsed = BrowseInteractiveParamsSchema.parse(params);

        let result: ToolResult;
        switch (parsed.action) {
          case 'open':
            result = await handleOpen(parsed, ctx, browserPool);
            break;
          case 'snapshot':
            result = await handleSnapshot(ctx);
            break;
          case 'click':
            result = await handleClick(parsed, ctx);
            break;
          case 'fill':
            result = await handleFill(parsed, ctx);
            break;
          case 'screenshot':
            result = await handleScreenshot(ctx);
            break;
          case 'get_text':
            result = await handleGetText(parsed, ctx);
            break;
          case 'close':
            result = await handleClose(ctx);
            break;
        }

        actionSuccess = result.success;
        errorCode = result.errorCode;
        return result;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        errorCode = 'browse_interactive.internal_error';
        return { success: false, error: `browse_interactive failed: ${msg}`, retryable: false };
      } finally {
        if (ctx.capabilityEngine) {
          ctx.capabilityEngine.recordEnd('browse_interactive', ctx.sessionId, {
            capability: 'browse_interactive',
            agentId: ctx.agentId,
            sessionId: ctx.sessionId,
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            inputSummary: `action=${(params as Record<string, unknown>)?.['action'] ?? 'unknown'}`,
            outputSummary: actionSuccess ? 'ok' : (errorCode ?? 'error'),
            success: actionSuccess,
            errorCode,
          });
        }
      }
    },
  };

  return [browseInteractiveTool];
}

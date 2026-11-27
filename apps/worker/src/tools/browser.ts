import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readlink, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolResult, ToolContext, BrowserPoolPort } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { capabilityDeniedResult, nonFaultError } from './tool-errors.js';
import { isHostPrivate } from './ssrf-guard.js';
import { getWorkspacePaths, resolveWorkspacePath } from './workspace.js';

const logger = createLogger('tools:browser');

const CDP_COMMAND_TIMEOUT_MS = 10_000;
// Actions that wait on page-side rendering (select, and upload) get a longer per-command budget.
const LONG_CDP_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_SNAPSHOT_MAX_NODES = 200;
// Upload cap (10 MiB) is separate from the read-tool maxFileBytes default. Chunks are a multiple of 4 base64 characters.
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_CHUNK_CHARS = 512 * 1024;
// Whole upload (read, transfer and attach) must finish within this budget; checked before each chunk.
const UPLOAD_DEADLINE_MS = 60_000;
const UPLOAD_READ_STEP_BYTES = 256 * 1024;

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

  async send(
    method: string,
    params?: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP WebSocket not connected');
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? CDP_COMMAND_TIMEOUT_MS;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

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
  startedAt: number;
}

// Key: `${agentId}:${sessionId}`
const activeSessions = new Map<string, ActiveSession>();

function sessionKey(ctx: ToolContext): string {
  return `${ctx.agentId}:${ctx.sessionId}`;
}

// ── Tool schema ─────────────────────────────────────────────────────────────

const BrowseInteractiveParamsSchema = z.object({
  action: z.enum([
    'open', 'snapshot', 'click', 'fill', 'screenshot', 'get_text', 'close',
    'select', 'check', 'uncheck', 'press', 'type', 'upload',
  ]).describe('Browser action to perform'),
  url: z.string().url().optional()
    .describe('URL to navigate to (required for "open" action)'),
  selector: z.string().optional()
    .describe('CSS selector targeting an element (required for "click", "fill", "get_text", "select", "check", "uncheck", "upload"; optional for "type")'),
  file: z.string().optional()
    .describe('Relative path of the file to upload, from the workspace root (required for "upload" action). Absolute paths are rejected.'),
  value: z.string().optional()
    .describe('Value to fill into the element (required for "fill" action)'),
  waitFor: z.string().optional()
    .describe('Optional CSS selector to wait for after navigation or click'),
  option: z.string().optional()
    .describe('Option label or value to choose (required for "select" action)'),
  key: z.string().optional()
    .describe('Key to press, e.g. "Enter", "Tab", "ArrowDown", or a single character (required for "press" action)'),
  text: z.string().optional()
    .describe('Text to type (required for "type" action)'),
  maxNodes: z.number().int().min(1).max(1000).optional()
    .describe(`Maximum accessibility nodes to include (optional for "snapshot" action, default ${DEFAULT_SNAPSHOT_MAX_NODES})`),
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
      startedAt: Date.now(),
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

async function handleSnapshot(ctx: ToolContext, maxNodes?: number): Promise<ToolResult> {
  const sessionOrError = await requireSession(ctx);
  if (isToolResult(sessionOrError)) return sessionOrError;

  try {
    // Try accessibility tree first
    const result = await sessionOrError.cdp.send('Accessibility.getFullAXTree');
    const nodes = result['nodes'] as Array<Record<string, unknown>> | undefined;
    if (nodes && nodes.length > 0) {
      const text = formatAccessibilityTree(nodes, maxNodes);
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

function formatAccessibilityTree(
  nodes: Array<Record<string, unknown>>,
  maxNodes: number = DEFAULT_SNAPSHOT_MAX_NODES,
): string {
  const lines: string[] = [];
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

// ── Form actions ────────────────────────────────────────────────────────────
// Every mutating action reads the value back from the DOM and compares it with the request.
// The CDP acknowledgement alone is not treated as proof that the page changed.

interface KeyDefinition {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const ENTER_KEY: KeyDefinition = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };

// A Map rather than a plain object, so lookups like "constructor" cannot hit the prototype chain.
const NAMED_KEYS = new Map<string, KeyDefinition>([
  ['Enter', ENTER_KEY],
  ['Tab', { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }],
  ['Escape', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }],
  ['Backspace', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }],
  ['Delete', { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }],
  ['Home', { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }],
  ['End', { key: 'End', code: 'End', windowsVirtualKeyCode: 35 }],
  ['PageUp', { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 }],
  ['PageDown', { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }],
  ['ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }],
  ['ArrowUp', { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }],
  ['ArrowRight', { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }],
  ['ArrowDown', { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }],
]);

function resolveKey(key: string): KeyDefinition | undefined {
  const named = NAMED_KEYS.get(key);
  if (named) return named;
  // A single printable character carries text so that keyDown also inserts it into the focused field.
  if ([...key].length === 1) {
    const upper = key.toUpperCase();
    const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(key) ? `Digit${key}` : key;
    return { key, code, windowsVirtualKeyCode: upper.charCodeAt(0), text: key };
  }
  return undefined;
}

async function pressKey(cdp: CdpClient, def: KeyDefinition): Promise<void> {
  const base = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.windowsVirtualKeyCode,
    nativeVirtualKeyCode: def.windowsVirtualKeyCode,
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(def.text !== undefined ? { text: def.text } : {}) });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function evaluateInPage(
  cdp: CdpClient,
  expression: string,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    { timeoutMs },
  );
  if (result['exceptionDetails']) {
    throw new Error('page script raised an exception');
  }
  return ((result['result'] as Record<string, unknown> | undefined)?.['value'] ?? {}) as Record<string, unknown>;
}

// Reads the current value of a form control, falling back to text content for non-input elements.
const READ_VALUE_JS = `(el) => ('value' in el && typeof el.value === 'string' ? el.value : (el.textContent ?? ''))`;

async function handleSelect(params: BrowseParams, ctx: ToolContext): Promise<ToolResult> {
  if (!params.selector) {
    return nonFaultError('browse_interactive: "selector" is required for action "select"');
  }
  if (!params.option) {
    return nonFaultError('browse_interactive: "option" is required for action "select"');
  }
  const sessionOrError = await requireSession(ctx);
  if (isToolResult(sessionOrError)) return sessionOrError;

  const cdp = sessionOrError.cdp;
  const selector = JSON.stringify(params.selector);
  const option = JSON.stringify(params.option);
  const timeoutMs = LONG_CDP_COMMAND_TIMEOUT_MS;

  try {
    const prepared = await evaluateInPage(cdp, `(() => {
      const el = document.querySelector(${selector});
      if (!el) return { ok: false, error: 'Element not found' };
      if (el.tagName === 'SELECT') {
        const match = [...el.options].find(o => o.label === ${option})
          ?? [...el.options].find(o => o.value === ${option});
        if (!match) return { ok: false, error: 'No option matches the requested value' };
        el.value = match.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, native: true };
      }
      if (el.getAttribute('role') === 'combobox') {
        el.focus();
        if (document.activeElement !== el) return { ok: false, error: 'Element could not take focus' };
        if (typeof el.select === 'function') el.select();
        return { ok: true, native: false };
      }
      return { ok: false, error: 'Element is not a <select> or ARIA combobox' };
    })()`, timeoutMs);
    if (prepared['ok'] !== true) {
      return nonFaultError(`browse_interactive select: ${(prepared['error'] as string | undefined) ?? 'select failed'}`);
    }

    if (prepared['native'] === true) {
      const observed = await evaluateInPage(cdp, `(() => {
        const el = document.querySelector(${selector});
        if (!el) return { ok: false, error: 'Element not found' };
        return { ok: true, label: el.selectedOptions[0]?.label ?? '', value: el.value };
      })()`, timeoutMs);
      if (observed['ok'] !== true) {
        return nonFaultError(`browse_interactive select: ${(observed['error'] as string | undefined) ?? 'element not found'}`);
      }
      const label = String(observed['label'] ?? '');
      const value = String(observed['value'] ?? '');
      if (label !== params.option && value !== params.option) {
        return nonFaultError(
          `browse_interactive select: expected "${params.option}" but the control shows "${label}"`,
        );
      }
      return { success: true, data: { selected: label, selector: params.selector } };
    }

    await cdp.send('Input.insertText', { text: params.option }, { timeoutMs });
    // Options for a combobox are often rendered asynchronously after typing, so poll briefly.
    // The poll never sends Enter: on a form, Enter can submit the page.
    // Options are read only from the listbox that aria-controls names, never from the whole page.
    const chosen = await evaluateInPage(cdp, `(async () => {
      const want = ${option};
      const optionsInLinkedListbox = () => {
        const listId = document.querySelector(${selector})?.getAttribute('aria-controls');
        const listbox = listId ? document.getElementById(listId) : null;
        return listbox ? [...listbox.querySelectorAll('[role="option"]')] : null;
      };
      for (let i = 0; i < 20; i++) {
        const match = (optionsInLinkedListbox() ?? []).find(o => (o.textContent ?? '').trim() === want);
        if (match) {
          match.click();
          return { clicked: true, text: (match.textContent ?? '').trim() };
        }
        await new Promise(r => setTimeout(r, 100));
      }
      const options = optionsInLinkedListbox();
      if (options === null) return { clicked: false, noListbox: true };
      return {
        clicked: false,
        options: options.map(o => (o.textContent ?? '').trim()).filter(t => t !== '').slice(0, 10),
      };
    })()`, timeoutMs);
    if (chosen['noListbox'] === true) {
      return nonFaultError(
        'browse_interactive select: combobox has no linked listbox (aria-controls is missing or does not resolve); use a native <select> or a combobox that sets aria-controls',
      );
    }
    if (chosen['clicked'] !== true || typeof chosen['text'] !== 'string') {
      const options = Array.isArray(chosen['options']) ? (chosen['options'] as unknown[]).map(String) : [];
      const hint = options.length > 0
        ? `Available options: ${options.join(', ')}`
        : 'No options are visible';
      return nonFaultError(`browse_interactive select: no option matches "${params.option}". ${hint}`);
    }
    const matchedText = chosen['text'];

    // Read the displayed selection, not the text field's own value: after typing, that value is the search text.
    // Only the control's own container and its linked listbox are searched, never the whole page.
    const observed = await evaluateInPage(cdp, `(() => {
      const el = document.querySelector(${selector});
      if (!el) return { ok: false, error: 'Element not found' };
      const listId = el.getAttribute('aria-controls');
      const listbox = listId ? document.getElementById(listId) : null;
      let shown = null;
      for (let node = el.parentElement, depth = 0; !shown && node && depth < 4; node = node.parentElement, depth++) {
        // An ancestor that holds another combobox belongs to a different field, so stop before reading it.
        if (node.querySelectorAll('[role="combobox"]').length > 1) break;
        shown = node.querySelector('[class*="singleValue"], [class*="single-value"]');
      }
      if (!shown && listbox) shown = listbox.querySelector('[role="option"][aria-selected="true"]');
      if (!shown && !('value' in el)) shown = el;
      return {
        ok: true,
        expanded: el.getAttribute('aria-expanded'),
        selected: shown ? (shown.textContent ?? '').trim() : null,
      };
    })()`, timeoutMs);
    if (observed['ok'] !== true) {
      return nonFaultError(`browse_interactive select: ${(observed['error'] as string | undefined) ?? 'element not found'}`);
    }
    const selected = typeof observed['selected'] === 'string' ? observed['selected'] : null;
    if (selected !== matchedText) {
      return nonFaultError(selected === null
        ? `browse_interactive select: expected "${params.option}" but no selection is shown`
        : `browse_interactive select: expected "${params.option}" but the control shows "${selected}"`);
    }
    const expanded = observed['expanded'];
    if (typeof expanded === 'string' && expanded !== 'false') {
      return nonFaultError(`browse_interactive select: control is still expanded after choosing "${params.option}"`);
    }
    return { success: true, data: { selected: matchedText, selector: params.selector } };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return nonFaultError(`browse_interactive select failed: ${msg}`);
  }
}

// Shared by check and uncheck: clicks only when the current state differs from the requested one.
async function handleSetChecked(params: BrowseParams, ctx: ToolContext, action: 'check' | 'uncheck'): Promise<ToolResult> {
  if (!params.selector) {
    return nonFaultError(`browse_interactive: "selector" is required for action "${action}"`);
  }
  const sessionOrError = await requireSession(ctx);
  if (isToolResult(sessionOrError)) return sessionOrError;

  const cdp = sessionOrError.cdp;
  const selector = JSON.stringify(params.selector);
  const desired = action === 'check';
  const readState = `(() => {
    const el = document.querySelector(${selector});
    if (!el) return { ok: false, error: 'Element not found' };
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      return { ok: true, checked: el.checked };
    }
    const aria = el.getAttribute('aria-checked');
    if (aria === 'true' || aria === 'false') return { ok: true, checked: aria === 'true' };
    return { ok: false, error: 'Element is not a checkbox, radio, or aria-checked control' };
  })()`;

  try {
    const before = await evaluateInPage(cdp, readState);
    if (before['ok'] !== true) {
      return nonFaultError(`browse_interactive ${action}: ${(before['error'] as string | undefined) ?? 'element not found'}`);
    }
    if (before['checked'] === desired) {
      return { success: true, data: { checked: desired, selector: params.selector } };
    }

    await evaluateInPage(cdp, `document.querySelector(${selector})?.click()`);

    const after = await evaluateInPage(cdp, readState);
    if (after['ok'] !== true) {
      return nonFaultError(`browse_interactive ${action}: ${(after['error'] as string | undefined) ?? 'element not found'}`);
    }
    if (after['checked'] !== desired) {
      return nonFaultError(
        `browse_interactive ${action}: expected checked=${desired} but the control reports checked=${String(after['checked'])}`,
      );
    }
    return { success: true, data: { checked: after['checked'], selector: params.selector } };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return nonFaultError(`browse_interactive ${action} failed: ${msg}`);
  }
}

async function handlePress(params: BrowseParams, ctx: ToolContext): Promise<ToolResult> {
  if (!params.key) {
    return nonFaultError('browse_interactive: "key" is required for action "press"');
  }
  const keyDef = resolveKey(params.key);
  if (!keyDef) {
    return nonFaultError(`browse_interactive: unsupported key "${params.key}"`);
  }
  const sessionOrError = await requireSession(ctx);
  if (isToolResult(sessionOrError)) return sessionOrError;

  try {
    await pressKey(sessionOrError.cdp, keyDef);
    return { success: true, data: { pressed: params.key } };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return nonFaultError(`browse_interactive press failed: ${msg}`);
  }
}

async function handleType(params: BrowseParams, ctx: ToolContext): Promise<ToolResult> {
  if (params.text === undefined) {
    return nonFaultError('browse_interactive: "text" is required for action "type"');
  }
  const sessionOrError = await requireSession(ctx);
  if (isToolResult(sessionOrError)) return sessionOrError;

  const cdp = sessionOrError.cdp;
  const text = params.text;
  const target = params.selector
    ? `document.querySelector(${JSON.stringify(params.selector)})`
    : 'document.activeElement';
  const missing = params.selector
    ? 'Element not found'
    : 'No focused element to type into; pass "selector" to choose one';

  try {
    const prepared = await evaluateInPage(cdp, `(() => {
      const el = ${target};
      if (!el || el === document.body) return { ok: false, error: ${JSON.stringify(missing)} };
      el.focus();
      if (document.activeElement !== el) return { ok: false, error: 'Element could not take focus' };
      return { ok: true, before: (${READ_VALUE_JS})(el), start: typeof el.selectionStart === 'number' ? el.selectionStart : null };
    })()`);
    if (prepared['ok'] !== true) {
      return nonFaultError(`browse_interactive type: ${(prepared['error'] as string | undefined) ?? 'element not found'}`);
    }
    const before = String(prepared['before'] ?? '');
    // Input.insertText replaces the selection, so the new text starts at the caret position read here.
    const start = typeof prepared['start'] === 'number' ? prepared['start'] : null;

    await cdp.send('Input.insertText', { text });

    const after = await evaluateInPage(cdp, `(() => {
      const el = ${target};
      if (!el) return { ok: false, error: 'Element not found' };
      return { ok: true, value: (${READ_VALUE_JS})(el) };
    })()`);
    if (after['ok'] !== true) {
      return nonFaultError(`browse_interactive type: ${(after['error'] as string | undefined) ?? 'element not found'}`);
    }
    const observed = String(after['value'] ?? '');
    // Comparing against the previous value fails when the same text is retyped over a selection.
    // Elements with no caret (contenteditable, email, number) fall back to a changed-value check.
    const inserted = start !== null
      ? observed.slice(start, start + text.length) === text
      : observed.includes(text) && observed !== before;
    if (!inserted) {
      return nonFaultError(
        `browse_interactive type: expected "${text}" to be inserted but the control shows "${observed}". ` +
          'If the field reformats input (for example a phone mask), the text may have been entered; check the value before retrying',
      );
    }
    return { success: true, data: { value: observed, selector: params.selector } };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return nonFaultError(`browse_interactive type failed: ${msg}`);
  }
}

const UPLOAD_MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.rtf': 'application/rtf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function uploadMimeType(fileName: string): string {
  return UPLOAD_MIME_TYPES[extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

type UploadSource =
  | { ok: true; realPath: string; bytes: Buffer; sha256: string }
  | { ok: false; error: string };

/** Read at most limit + 1 bytes from the handle. Returns null when the file holds more than limit bytes. */
async function readBounded(handle: FileHandle, limit: number): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const want = Math.min(UPLOAD_READ_STEP_BYTES, limit + 1 - total);
    if (want <= 0) break;
    const chunk = Buffer.alloc(want);
    const { bytesRead } = await handle.read(chunk, 0, want, null);
    if (bytesRead === 0) break;
    parts.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return total > limit ? null : Buffer.concat(parts, total);
}

/**
 * Resolve an upload path inside the workspace root and read it, rejecting anything that is not a small regular file.
 * The bytes come only from the handle opened on the resolved real path, so the file that was checked is the file read.
 */
async function readUploadSource(agentId: string, file: string): Promise<UploadSource> {
  const root = getWorkspacePaths(agentId).root;
  const resolved = await resolveWorkspacePath(root, file);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  let handle: FileHandle | undefined;
  try {
    const realRoot = await realpath(root);
    const realFile = await realpath(resolved.absolutePath);
    if (!realFile.startsWith(realRoot + '/')) {
      return { ok: false, error: 'path escapes workspace root' };
    }

    // O_NONBLOCK: opening a FIFO returns at once instead of waiting for a writer. fstat then rejects it.
    handle = await open(realFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (info.isDirectory()) return { ok: false, error: `"${file}" is a directory, not a file` };
    if (!info.isFile()) return { ok: false, error: `"${file}" is not a regular file` };
    // A second name for the file could be used to change it outside the checks below.
    if (info.nlink > 1) return { ok: false, error: `"${file}" has more than one hard link` };
    // Early size check from the handle's stat, so an oversized file is never read into memory.
    if (info.size > UPLOAD_MAX_BYTES) {
      return { ok: false, error: `"${file}" is ${info.size} bytes, over the ${UPLOAD_MAX_BYTES / (1024 * 1024)} MiB upload limit` };
    }

    // Post-open containment check (Linux). /proc/self/fd/N names the path the handle was opened through, so a
    // parent directory swapped between realpath and open is caught here. Where /proc is missing (macOS, ENOENT),
    // the check is skipped with a warning. The dev/ino check below cannot see a parent swap (both lookups
    // follow the same path), so on macOS that swap is a residual limitation, recorded in the plan.
    let openedPath: string | undefined;
    try {
      openedPath = await readlink(`/proc/self/fd/${handle.fd}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      logger.warn({ agentId, sourcePath: realFile }, 'browse_interactive upload: /proc/self/fd unavailable, skipping post-open containment check');
    }
    // Linux only: the path the handle was opened through must be the path that passed the checks above.
    if (openedPath !== undefined && openedPath !== realFile) {
      return { ok: false, error: 'path escapes workspace root' };
    }

    // If the path now names a different inode than the one opened, it was swapped after the checks above.
    const current = await stat(realFile);
    if (current.dev !== info.dev || current.ino !== info.ino) {
      return { ok: false, error: `"${file}" changed while it was being opened` };
    }

    const bytes = await readBounded(handle, UPLOAD_MAX_BYTES);
    if (bytes === null) {
      return { ok: false, error: `"${file}" grew past the upload limit while it was read` };
    }
    return {
      ok: true,
      realPath: realFile,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return { ok: false, error: `"${file}" does not exist or cannot be read` };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function handleUpload(params: BrowseParams, ctx: ToolContext): Promise<ToolResult> {
  if (!params.selector) {
    return nonFaultError('browse_interactive: "selector" is required for action "upload"');
  }
  if (!params.file) {
    return nonFaultError('browse_interactive: "file" is required for action "upload"');
  }
  const sessionOrError = await requireSession(ctx);
  if (isToolResult(sessionOrError)) return sessionOrError;

  const deadline = Date.now() + UPLOAD_DEADLINE_MS;
  const deadlineError = 'browse_interactive upload: timed out before the file finished transferring';
  const source = await readUploadSource(ctx.agentId, params.file);
  if (!source.ok) return nonFaultError(`browse_interactive upload: ${source.error}`);

  const cdp = sessionOrError.cdp;
  const selector = JSON.stringify(params.selector);
  const stagingKey = JSON.stringify(`__herobidsUpload_${randomUUID()}`);
  const fileName = JSON.stringify(basename(params.file));
  const mimeType = JSON.stringify(uploadMimeType(params.file));
  const sizeBytes = source.bytes.byteLength;
  const timeoutMs = LONG_CDP_COMMAND_TIMEOUT_MS;
  // Set once page-side staging may exist, so any failure before a confirmed attach clears it.
  let needsCleanup = false;

  try {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return nonFaultError(deadlineError);
    // Set before the call: a prepare that fails after the page ran still needs its staging key cleared.
    needsCleanup = true;
    const prepared = await evaluateInPage(cdp, `(() => {
      const el = document.querySelector(${selector});
      if (!el) return { ok: false, error: 'Element not found' };
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') return { ok: false, error: 'Element is not a file input' };
      window[${stagingKey}] = [];
      return { ok: true };
    })()`, Math.min(timeoutMs, remainingMs));
    if (prepared['ok'] !== true) {
      return nonFaultError(`browse_interactive upload: ${(prepared['error'] as string | undefined) ?? 'upload failed'}`);
    }

    const base64 = source.bytes.toString('base64');
    for (let offset = 0; offset < base64.length; offset += UPLOAD_CHUNK_CHARS) {
      // Each call gets only the budget that is left, so no single call can outlive the deadline.
      const remaining = deadline - Date.now();
      if (remaining <= 0) return nonFaultError(deadlineError);
      const chunk = JSON.stringify(base64.slice(offset, offset + UPLOAD_CHUNK_CHARS));
      const pushed = await evaluateInPage(cdp, `(() => {
        const parts = window[${stagingKey}];
        if (!Array.isArray(parts)) return { ok: false, error: 'Upload staging was lost' };
        parts.push(${chunk});
        return { ok: true };
      })()`, Math.min(timeoutMs, remaining));
      if (pushed['ok'] !== true) {
        return nonFaultError(`browse_interactive upload: ${(pushed['error'] as string | undefined) ?? 'chunk transfer failed'}`);
      }
    }

    // The finalize script removes the staging buffer before any step that can throw.
    const remainingForAttach = deadline - Date.now();
    if (remainingForAttach <= 0) return nonFaultError(deadlineError);
    const attached = await evaluateInPage(cdp, `(() => {
      const parts = window[${stagingKey}];
      delete window[${stagingKey}];
      if (!Array.isArray(parts)) return { ok: false, error: 'Upload staging was lost' };
      const el = document.querySelector(${selector});
      if (!el) return { ok: false, error: 'Element not found' };
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') return { ok: false, error: 'Element is not a file input' };
      const binary = atob(parts.join(''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      if (bytes.length !== ${sizeBytes}) return { ok: false, error: 'Transferred size does not match the source file' };
      const file = new File([bytes], ${fileName}, { type: ${mimeType} });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const count = el.files ? el.files.length : 0;
      if (count === 0) return { ok: false, error: 'File input reports no files after the upload' };
      return { ok: true, name: file.name, size: file.size, count, url: location.href };
    })()`, Math.min(timeoutMs, remainingForAttach));
    if (attached['ok'] !== true) {
      return nonFaultError(`browse_interactive upload: ${(attached['error'] as string | undefined) ?? 'upload failed'}`);
    }
    if (attached['size'] !== sizeBytes || typeof attached['count'] !== 'number' || attached['count'] < 1) {
      return nonFaultError('browse_interactive upload: the page did not confirm the attached file');
    }
    needsCleanup = false;

    // Audit trail: metadata only, never file content. The URL is logged without its query and fragment.
    logger.info({
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      sourcePath: source.realPath,
      sizeBytes,
      sha256: source.sha256,
      pageUrl: String(attached['url'] ?? '').replace(/[?#][\s\S]*$/, ''),
    }, 'browse_interactive upload attached file');

    return {
      success: true,
      data: { fileName: basename(params.file), sizeBytes, filesCount: attached['count'], selector: params.selector },
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return nonFaultError(`browse_interactive upload failed: ${msg}`);
  } finally {
    if (needsCleanup) {
      await evaluateInPage(cdp, `delete window[${stagingKey}]`).catch(() => undefined);
    }
  }
}

async function handleClose(ctx: ToolContext): Promise<ToolResult> {
  const key = sessionKey(ctx);
  const session = activeSessions.get(key);
  if (!session) {
    return { success: true, data: { message: 'No active session to close' } };
  }

  const durationMs = Date.now() - session.startedAt;
  session.cdp.close();
  await session.browserPool.releaseSession(session.browserSessionId);
  activeSessions.delete(key);

  ctx.usageBilling?.recordBrowserSession({ durationMs, browserSessionId: session.browserSessionId });

  return { success: true, data: { message: 'Browser session closed', durationMs } };
}

/** Clean up any active browser sessions for the given agent. Call on agent session teardown. */
export async function cleanupBrowserSessions(
  agentId: string,
  onSessionClosed?: (input: { durationMs: number; browserSessionId: string }) => void,
): Promise<void> {
  const keysToDelete: string[] = [];
  for (const [key, session] of activeSessions) {
    if (key.startsWith(`${agentId}:`)) {
      const durationMs = Date.now() - session.startedAt;
      session.cdp.close();
      await session.browserPool.releaseSession(session.browserSessionId);
      onSessionClosed?.({ durationMs, browserSessionId: session.browserSessionId });
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
      'Interactive browser automation: open pages, click elements, fill forms, select options, check or uncheck boxes, press keys, type text, take screenshots, and read accessibility trees. ' +
      'Actions: open (navigate to URL), snapshot (get accessibility tree as structured text; optional maxNodes), click (click element by CSS selector), ' +
      'fill (fill form field by CSS selector), select (choose an option in a native select or ARIA combobox by selector and option), ' +
      'check / uncheck (set a checkbox or radio by selector), upload (attach a workspace file, given as "file", to a file input by selector), press (send a key such as Enter or Tab), ' +
      'type (insert text into the focused element, or the element matched by selector; fields that reformat input, such as phone masks, can report an error even when the text was entered), ' +
      'screenshot (capture page as base64 PNG), get_text (read element text), ' +
      'close (release browser session). Call "open" first to start a session. ' +
      'You may use either snapshot or screenshot for page understanding — snapshot returns compact structured text (element roles and names), ' +
      'while screenshot returns a large base64 image and requires vision capability to interpret. Use screenshot only when visual layout matters.',
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
            result = await handleSnapshot(ctx, parsed.maxNodes);
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
          case 'select':
            result = await handleSelect(parsed, ctx);
            break;
          case 'check':
            result = await handleSetChecked(parsed, ctx, 'check');
            break;
          case 'uncheck':
            result = await handleSetChecked(parsed, ctx, 'uncheck');
            break;
          case 'press':
            result = await handlePress(parsed, ctx);
            break;
          case 'type':
            result = await handleType(parsed, ctx);
            break;
          case 'upload':
            result = await handleUpload(parsed, ctx);
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

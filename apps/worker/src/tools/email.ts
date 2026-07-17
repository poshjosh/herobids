import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { convertZodToJsonSchema } from './registry.js';
import { resolveGmailTokens } from '../gmail-credential-resolver.js';
import { createGmailAdapter, type GmailApiError } from '../gmail-adapter.js';

// ---------------------------------------------------------------------------
// Dependency injection (set before first tool execution)
// ---------------------------------------------------------------------------

let _db: Database | null = null;
let _gmailConfig: { clientId: string; clientSecret: string; redirectUri: string; dailySendLimit?: number } | null = null;
let _initialized = false;

/** Must be called after DB and config are available, before any tool execution. */
export function initEmailTools(
  db: Database,
  gmailConfig: { clientId: string; clientSecret: string; redirectUri: string; dailySendLimit?: number },
): void {
  if (_initialized) return;
  _db = db;
  _gmailConfig = gmailConfig;
  _initialized = true;
}

// ---------------------------------------------------------------------------
// send_email
// ---------------------------------------------------------------------------

const SendEmailParamsSchema = z.object({
  to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(10)]),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  cc: z.union([z.string().email(), z.array(z.string().email()).max(10)]).optional(),
  bcc: z.union([z.string().email(), z.array(z.string().email()).max(10)]).optional(),
});

export const sendEmailTool: AgentTool = {
  name: 'send_email',
  description:
    'Send an email via your connected Gmail account. Supports plain text and HTML, cc and bcc recipients. ' +
    'Before sending to unfamiliar recipients, confirm with the user via send_message.',
  parametersSchema: SendEmailParamsSchema,
  parameters: convertZodToJsonSchema(SendEmailParamsSchema),
  category: 'write-messaging',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!_db || !_gmailConfig) {
      return { success: false, error: 'Email tools not initialized — missing database or Gmail config.', fault: false };
    }

    const parsed = SendEmailParamsSchema.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: `Invalid send_email parameters: ${parsed.error.message}`, fault: false };
    }

    const { to, subject, body, cc, bcc } = parsed.data;

    // Per-agent daily send rate limit
    const dailyLimit = _gmailConfig.dailySendLimit ?? 50;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const rateLimitHashKey = 'gmail:daily_sends';
    const rateLimitField = `${ctx.agentId}:${today}`;
    const currentCount = await ctx.redis.hget(rateLimitHashKey, rateLimitField);
    const count = currentCount ? parseInt(currentCount, 10) : 0;
    if (count >= dailyLimit) {
      return {
        success: false,
        error: `Daily email limit reached (${count}/${dailyLimit}). Try again tomorrow.`,
        errorCode: 'gmail.rate_limited',
        retryable: false,
        fault: false,
      };
    }

    // Resolve Gmail credentials (with lazy token refresh)
    const tokenResult = await resolveGmailTokens(_db, ctx.agentId, {
      ..._gmailConfig,
      dailySendLimit: _gmailConfig.dailySendLimit ?? 50,
    });
    if (!tokenResult.ok) {
      const nonRetryableCodes = new Set([
        'connection.missing',
        'gmail.decrypt_failed',
        'gmail.no_encryption_key',
        'gmail.not_configured',
        'gmail.token_refresh_failed',
      ]);
      return {
        success: false,
        error: tokenResult.error.message,
        errorCode: tokenResult.error.code,
        retryable: !nonRetryableCodes.has(tokenResult.error.code),
        fault: false,
      };
    }

    // Send via Gmail adapter
    const adapter = createGmailAdapter({ accessToken: tokenResult.data.accessToken });
    try {
      const result = await adapter.sendEmail({ to, subject, body, cc, bcc });
      // Increment daily counter after successful send
      await ctx.redis.hset(rateLimitHashKey, rateLimitField, String(count + 1));
      await ctx.redis.expire(rateLimitHashKey, 86400 * 2);
      return {
        success: true,
        data: {
          ok: true,
          messageId: result.messageId,
          threadId: result.threadId,
          from: tokenResult.data.email,
          to: Array.isArray(to) ? to : [to],
        },
      };
    } catch (err) {
      const gmailErr = err as GmailApiError;
      return {
        success: false,
        error: gmailErr.message ?? 'Failed to send email.',
        errorCode: gmailErr.code ?? 'gmail.send_failed',
        retryable: gmailErr.status != null && (gmailErr.status >= 500 || gmailErr.status === 429),
        fault: !gmailErr.status || gmailErr.status >= 500,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// search_emails
//
// PARKED — not registered in emailTools below. gmail.readonly was removed
// from the OAuth scope to avoid the Google review burden, so this tool has
// no credential to run against. Re-enable only once inbox-read scope
// verification is approved (see docs/features/2026/07/17/006-remove-unused-provider-table-and-gmail-readonly-scope/001-plan.md).
// ---------------------------------------------------------------------------

const SearchEmailsParamsSchema = z.object({
  query: z.string().min(1).max(500).describe('Gmail search query syntax (e.g. "from:alice@example.com", "subject:invoice", "newer_than:7d")'),
  maxResults: z.number().int().min(1).max(50).default(20),
});

export const searchEmailsTool: AgentTool = {
  name: 'search_emails',
  description:
    'Search your connected Gmail inbox using Gmail search syntax. Returns matching email summaries (id, threadId, from, to, subject, snippet, date, labels). ' +
    'Use specific queries to narrow results — broad queries may return many emails.',
  parametersSchema: SearchEmailsParamsSchema,
  parameters: convertZodToJsonSchema(SearchEmailsParamsSchema),
  category: 'read-web',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!_db || !_gmailConfig) {
      return { success: false, error: 'Email tools not initialized — missing database or Gmail config.', fault: false };
    }

    const parsed = SearchEmailsParamsSchema.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: `Invalid search_emails parameters: ${parsed.error.message}`, fault: false };
    }

    const { query, maxResults } = parsed.data;

    // Resolve Gmail credentials (with lazy token refresh)
    const tokenResult = await resolveGmailTokens(_db, ctx.agentId, {
      ..._gmailConfig,
      dailySendLimit: _gmailConfig.dailySendLimit ?? 50,
    });
    if (!tokenResult.ok) {
      const nonRetryableCodes = new Set([
        'connection.missing',
        'gmail.decrypt_failed',
        'gmail.no_encryption_key',
        'gmail.not_configured',
        'gmail.token_refresh_failed',
      ]);
      return {
        success: false,
        error: tokenResult.error.message,
        errorCode: tokenResult.error.code,
        retryable: !nonRetryableCodes.has(tokenResult.error.code),
        fault: false,
      };
    }

    // Search via Gmail adapter
    const adapter = createGmailAdapter({ accessToken: tokenResult.data.accessToken });
    try {
      const emails = await adapter.searchEmails({ query, maxResults });
      return {
        success: true,
        data: {
          ok: true,
          query,
          resultCount: emails.length,
          emails,
        },
      };
    } catch (err) {
      const gmailErr = err as GmailApiError;
      return {
        success: false,
        error: gmailErr.message ?? 'Failed to search emails.',
        errorCode: gmailErr.code ?? 'gmail.search_failed',
        retryable: gmailErr.status != null && (gmailErr.status >= 500 || gmailErr.status === 429),
        fault: !gmailErr.status || gmailErr.status >= 500,
      };
    }
  },
};

export const emailTools: AgentTool[] = [sendEmailTool];

import { SendMessageParamsSchema } from './tools/messaging.js';

const INTERNAL_MARKUP_PATTERN = /<\/?(function_calls|function|invoke|tool_call|tool_use|thinking|reasoning)\b/i;
const TOOL_CALL_JSON_PATTERN = /^\{[\s\S]*"(tool|name)"\s*:/;
const REPLY_BLOCK_PATTERN = /<reply>([\s\S]*?)<\/reply>/gi;
const UNCLOSED_REPLY_PATTERN = /<reply>(?![\s\S]*<\/reply>)/i;

export type ReplyDelivery = {
  bodies: string[];
  mode: 'tagged' | 'untagged' | 'none';
  unclosedTag: boolean;
};

function validBody(candidate: string): string | null {
  const body = candidate.trim();
  if (body.length === 0) return null;
  if (INTERNAL_MARKUP_PATTERN.test(body)) return null;
  if (TOOL_CALL_JSON_PATTERN.test(body)) return null;
  const parsed = SendMessageParamsSchema.shape.body.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/**
 * Resolves the user-facing reply bodies from the judge's plain-text response.
 *
 * Tagged mode: delivers each complete `<reply>…</reply>` block; an unclosed tag is reported
 * and ignored. Untagged mode: when no `<reply>` tag is present, the whole response is
 * delivered if it passes the same checks.
 */
export function resolveReplyDelivery(assistantResponse: string): ReplyDelivery {
  const unclosedTag = UNCLOSED_REPLY_PATTERN.test(assistantResponse);
  const tagged = [...assistantResponse.matchAll(REPLY_BLOCK_PATTERN)]
    .map((match) => validBody(match[1] ?? ''))
    .filter((body): body is string => body !== null);

  if (tagged.length > 0 || /<reply>/i.test(assistantResponse)) {
    return { bodies: tagged, mode: 'tagged', unclosedTag };
  }
  const body = validBody(assistantResponse);
  return body === null
    ? { bodies: [], mode: 'none', unclosedTag }
    : { bodies: [body], mode: 'untagged', unclosedTag };
}

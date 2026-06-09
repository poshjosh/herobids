/**
 * Internal LLM provider helper — delegates to @herobids/llm.
 * Strategy-specific types are kept as narrower aliases for backward compatibility.
 */

import { callLlmProvider as callLlmProviderImpl } from '@herobids/llm';
import type { LlmProviderConfig, LlmResult } from '@herobids/llm';

export type { LlmProviderConfig, LlmResult } from '@herobids/llm';

export interface LlmRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  temperature?: number;
}

export async function callLlmProvider(
  config: LlmProviderConfig,
  request: LlmRequest,
): Promise<LlmResult> {
  return callLlmProviderImpl(config, {
    messages: request.messages,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
  });
}

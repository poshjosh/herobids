import type { PromptTimingContext } from './prompt-timing-context.js';
import { formatPromptTimingContextLines } from './prompt-timing-context.js';

export interface ScoutDecision {
  disposition: 'hold' | 'escalate';
  reason?: string;
}

export const DEFAULT_SCOUT_MODELS = {
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4.1-mini',
  openrouter: 'openai/gpt-4.1-mini',
} as const;

export function resolveDefaultScoutModel(
  provider: string,
  judgeModel: string,
  defaultModels: { anthropic: string; openai: string; openrouter: string } = DEFAULT_SCOUT_MODELS,
): string {
  switch (provider) {
    case 'anthropic':
      return defaultModels.anthropic;
    case 'openai':
      return defaultModels.openai;
    case 'openrouter':
      return defaultModels.openrouter;
    default:
      return judgeModel;
  }
}

export function buildScoutSystemPrompt(params: {
  agentId: string;
  name?: string;
  goal: string;
  readOnlyTools: string[];
  timing: PromptTimingContext;
}): string {
  return [
    `You are the scout for agent "${params.name ?? params.agentId}".`,
    `## Your Goal`,
    params.goal,
    '## Operating Context',
    ...formatPromptTimingContextLines(params.timing),
    '## Available Tools',
    `You can call the following read-only tools: ${params.readOnlyTools.join(', ') || 'none'}.`,
    '## Instructions',
    `Decide whether agent "${params.name ?? params.agentId}" needs to act this tick.`,
    'Use tools only when they help decide between hold versus escalate.',
    'Respond with JSON only: {"disposition":"hold"|"escalate","reason":"short reason"}.',
  ].join('\n');
}

function extractJsonObject(text: string): string | null {
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return text.slice(firstBrace, lastBrace + 1);
}

export function parseScoutDecision(response: string): ScoutDecision {
  const jsonText = extractJsonObject(response);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as Partial<ScoutDecision>;
      if (parsed.disposition === 'hold' || parsed.disposition === 'escalate') {
        return {
          disposition: parsed.disposition,
          reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
        };
      }
    } catch {
      // fall through to keyword parsing
    }
  }

  if (/escalate/i.test(response)) {
    return { disposition: 'escalate', reason: response.trim() };
  }

  return { disposition: 'hold', reason: response.trim() || 'scout_hold' };
}
export interface ScoutDecision {
  disposition: 'hold' | 'escalate';
  reason?: string;
}

export function resolveDefaultScoutModel(provider: string, judgeModel: string): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-3-5-haiku-latest';
    case 'openai':
      return 'gpt-4.1-mini';
    case 'openrouter':
      return 'openai/gpt-4.1-mini';
    default:
      return judgeModel;
  }
}

export function buildScoutSystemPrompt(params: {
  agentId: string;
  goal: string;
  readOnlyTools: string[];
}): string {
  return [
    `You are the scout phase for agent ${params.agentId}.`,
    `Goal: ${params.goal}`,
    `Visible read-only tools: ${params.readOnlyTools.join(', ') || 'none'}.`,
    'Decide whether the judge model needs to act this tick.',
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
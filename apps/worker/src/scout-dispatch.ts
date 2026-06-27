import { formatAgentGoalLiteralBlock } from '@herobids/domain';
import type { PromptTimingContext } from './prompt-timing-context.js';
import { formatPromptTimingContextLines } from './prompt-timing-context.js';

export interface ScoutDecision {
  disposition: 'hold' | 'escalate';
  reason?: string;
}

const SCOUT_WORKSPACE_CONTEXT_TOOL_NAMES = new Set([
  'execute_code',
  'read_file',
  'list_files',
  'write_file',
  'delete_file',
]);

export function buildScoutSystemPrompt(params: {
  agentId: string;
  name?: string;
  goal: string;
  readOnlyTools: string[];
  timing: PromptTimingContext;
  workspaceRoot?: string;
  venueLines?: string[];
}): string {
  const includeWorkspaceContext = Boolean(params.workspaceRoot)
    && params.readOnlyTools.some((tool) => SCOUT_WORKSPACE_CONTEXT_TOOL_NAMES.has(tool));

  const venueSection = params.venueLines && params.venueLines.length > 0
    ? ['## Trading Venue', ...params.venueLines]
    : [];

  return [
    `You are the scout phase for agent "${params.name ?? params.agentId}".`,
    `## Your Goal`,
    formatAgentGoalLiteralBlock(params.goal),
    '## Operating Context',
    ...formatPromptTimingContextLines(params.timing),
    ...(includeWorkspaceContext
      ? [
          `Workspace root: ${params.workspaceRoot}`,
          'Use paths relative to workspace root, such as log.txt or folder/output.txt.',
        ]
      : []),
    ...venueSection,
    '## Available Tools',
    `Visible read-only tools: ${params.readOnlyTools.join(', ') || 'none'}.`,
    '## Instructions',
    `Decide whether agent "${params.name ?? params.agentId}" needs to act this tick.`,
    'Use tools only when they help decide hold versus escalate.',
    `Only escalate when there is good reason for agent "${params.name ?? params.agentId}" to act this tick.`,
    'Respond with JSON only. disposition must be either "hold" or "escalate". Example: {"disposition":"hold","reason":"short reason"}.',
    'Your default answer (for example if you cannot decide) should be: {"disposition":"hold","reason":"scout_hold"}.',
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
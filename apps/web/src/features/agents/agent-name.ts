import type { AgentStyleValue } from './style-mapping.js';

export function generateAgentName(style: AgentStyleValue, counter: number): string {
  return `${style}-agent-${counter}`;
}

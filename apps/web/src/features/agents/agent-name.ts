import type { AgentStyleValue } from './style-mapping.js';

export function generateAgentName(style: AgentStyleValue): string {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${style}-agent-${hex}`;
}

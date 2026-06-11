/**
 * Shared helper for normalizing stored agent goal/prompt text.
 *
 * Stored prompts may carry legacy embedded operator context appended by the
 * old web create flow. This module provides a single normalization path used
 * by the worker prompt builder and scout dispatch so both see the same clean
 * user intent regardless of when the agent was created.
 */

const OPERATOR_CONTEXT_MARKER = '\n\nOperator context:\n';
const GENERATED_OPERATOR_CONTEXT_LINE = /^- (Selected skills:|Trading capability selected\.|Selected trading binding:|Risk tolerance:)/;

// Matches the older inline-suffix format produced before the marker convention.
const LEGACY_INLINE_CONTEXT =
  /\s+Execution mode: (?:paper|shadow|live)\.(?:\s+Trading capability selected(?:\s+with provider hint .+?)?\.)?(?:\s+Risk tolerance: (?:conservative|moderate|aggressive)\.)?\s*$/;

/**
 * Return the canonical user goal from a stored prompt string.
 *
 * Strips the `Operator context:` block (current format) and the older
 * inline execution-mode suffix (legacy format) when present.
 * Returns the trimmed text unchanged for clean prompts.
 */
export function normalizeAgentGoal(prompt: string): string {
  const markerIndex = prompt.indexOf(OPERATOR_CONTEXT_MARKER);
  if (markerIndex >= 0) {
    const contextLines = prompt
      .slice(markerIndex + OPERATOR_CONTEXT_MARKER.length)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (contextLines.length > 0 && contextLines.every((line) => GENERATED_OPERATOR_CONTEXT_LINE.test(line))) {
      return prompt.slice(0, markerIndex).trim();
    }
  }

  return prompt.replace(LEGACY_INLINE_CONTEXT, '').trim();
}

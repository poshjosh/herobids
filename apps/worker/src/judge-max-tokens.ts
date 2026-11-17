/**
 * Output-token limit for each judge model call.
 *
 * An agent with a resolved runtime policy (style defaults plus overrides, capped by the operator
 * ceilings) uses its own `judgeMaxTokens`, the same way the scout uses `scoutMaxTokens`. Without a
 * resolved policy the operator default (`llm.maxTokens`, passed as `LLM_MAX_TOKENS`) applies.
 *
 * The limit is shared with reasoning: at reasoning effort `high`, about 80% of it can go to reasoning.
 */
export function resolveJudgeMaxTokens(
  operatorMaxTokens: number,
  resolvedPolicy: { judgeMaxTokens: number } | undefined,
): number {
  return resolvedPolicy ? resolvedPolicy.judgeMaxTokens : operatorMaxTokens;
}

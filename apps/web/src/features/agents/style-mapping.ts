export type AgentStyleValue = 'careful' | 'balanced' | 'bold';

export interface StyleDefaults {
  costPreset: 'minimal' | 'standard' | 'premium';
  tickIntervalMins: string;
  dailySpendBudgetUsd: string;
  openPositionEscalationToJudgePolicy: 'never' | 'uncovered_or_triggered' | 'always';
  // Tool turn limits
  scoutMaxTurns: number;
  judgeMaxTurns: number;
  // LLM token limits
  scoutMaxTokens: number;
  judgeMaxTokens: number;
  lightThinkingTokens: number;
  deepThinkingTokens: number;
  // Trading hours
  allowedHoursUtc: number[];
  weekendPause: boolean;
  // Context budgets
  maxHistoryMessages: number;
  maxHistoryTokens: number;
  maxRecentToolMessages: number;
  maxToolResultChars: number;
  maxVisibleToolSchemas: number;
  maxContextBlockChars: number;
  toolResultFullRetentionTurns: number;
  toolResultMaxStaleChars: number;
  // Scout hold
  maxHoldDurationMs: number;
}

/** Per-field overrides for runtime policy. Fields not present use the style default. */
export type RuntimePolicyOverrides = Partial<{
  scoutMaxTurns: number | null;
  judgeMaxTurns: number | null;
  scoutMaxTokens: number | null;
  judgeMaxTokens: number | null;
  lightThinkingTokens: number | null;
  deepThinkingTokens: number | null;
  allowedHoursUtc: number[] | null;
  weekendPause: boolean | null;
  maxHistoryMessages: number | null;
  maxHistoryTokens: number | null;
  maxRecentToolMessages: number | null;
  maxToolResultChars: number | null;
  maxVisibleToolSchemas: number | null;
  maxContextBlockChars: number | null;
  toolResultFullRetentionTurns: number | null;
  toolResultMaxStaleChars: number | null;
  maxHoldDurationMs: number | null;
}>;

export const STYLE_CONFIG: Record<AgentStyleValue, StyleDefaults> = {
  careful:  {
    costPreset: 'minimal',
    tickIntervalMins: '90',
    dailySpendBudgetUsd: '3',
    openPositionEscalationToJudgePolicy: 'never',
    scoutMaxTurns: 10,
    judgeMaxTurns: 25,
    scoutMaxTokens: 512,
    judgeMaxTokens: 2_048,
    lightThinkingTokens: 1_024,
    deepThinkingTokens: 4_096,
    allowedHoursUtc: [14, 15, 16, 17, 18, 19, 20],
    weekendPause: true,
    maxHistoryMessages: 10,
    maxHistoryTokens: 20_000,
    maxRecentToolMessages: 3,
    maxToolResultChars: 2_000,
    maxVisibleToolSchemas: 32,
    maxContextBlockChars: 2_000,
    toolResultFullRetentionTurns: 2,
    toolResultMaxStaleChars: 250,
    maxHoldDurationMs: 10_800_000,
  },
  balanced: {
    costPreset: 'standard',
    tickIntervalMins: '30',
    dailySpendBudgetUsd: '10',
    openPositionEscalationToJudgePolicy: 'uncovered_or_triggered',
    scoutMaxTurns: 30,
    judgeMaxTurns: 75,
    scoutMaxTokens: 1_024,
    judgeMaxTokens: 4_096,
    lightThinkingTokens: 2_048,
    deepThinkingTokens: 10_240,
    allowedHoursUtc: [],
    weekendPause: true,
    maxHistoryMessages: 20,
    maxHistoryTokens: 40_000,
    maxRecentToolMessages: 6,
    maxToolResultChars: 4_000,
    maxVisibleToolSchemas: 64,
    maxContextBlockChars: 4_000,
    toolResultFullRetentionTurns: 3,
    toolResultMaxStaleChars: 500,
    maxHoldDurationMs: 3_600_000,
  },
  bold:     {
    costPreset: 'premium',
    tickIntervalMins: '10',
    dailySpendBudgetUsd: '30',
    openPositionEscalationToJudgePolicy: 'always',
    scoutMaxTurns: 100,
    judgeMaxTurns: 300,
    scoutMaxTokens: 2_048,
    judgeMaxTokens: 8_192,
    lightThinkingTokens: 4_096,
    deepThinkingTokens: 20_480,
    allowedHoursUtc: [],
    weekendPause: false,
    maxHistoryMessages: 40,
    maxHistoryTokens: 80_000,
    maxRecentToolMessages: 12,
    maxToolResultChars: 8_000,
    maxVisibleToolSchemas: 128,
    maxContextBlockChars: 8_000,
    toolResultFullRetentionTurns: 5,
    toolResultMaxStaleChars: 1_000,
    maxHoldDurationMs: 1_800_000,
  },
};

export function resolveStyleDefaults(style: AgentStyleValue): StyleDefaults {
  const config = STYLE_CONFIG[style];
  if (!config) {
    return STYLE_CONFIG.balanced;
  }
  return config;
}

/** Build a compact summary string for a style, e.g. "30 turns · 4K tokens · $10/day" */
export function formatStyleSummary(style: AgentStyleValue): string {
  const d = resolveStyleDefaults(style);
  const turns = `${d.scoutMaxTurns}/${d.judgeMaxTurns} turns`;
  const tokens = d.judgeMaxTokens >= 1_024
    ? `${Math.round(d.judgeMaxTokens / 1_024)}K tokens`
    : `${d.judgeMaxTokens} tokens`;
  return `${turns} · ${tokens} · $${d.dailySpendBudgetUsd}/day`;
}

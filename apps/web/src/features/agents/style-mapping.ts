export type AgentStyleValue = 'careful' | 'balanced' | 'bold';

export interface StyleDefaults {
  costPreset: 'minimal' | 'standard' | 'premium';
  tickIntervalMins: string;
  dailySpendBudgetUsd: string;
  riskTolerance: 'conservative' | 'moderate' | 'aggressive';
  openPositionEscalationToJudgePolicy: 'never' | 'uncovered_or_triggered' | 'always';
}

export const STYLE_CONFIG: Record<AgentStyleValue, StyleDefaults> = {
  careful:  { costPreset: 'minimal',  tickIntervalMins: '90', dailySpendBudgetUsd: '3',  riskTolerance: 'conservative', openPositionEscalationToJudgePolicy: 'never' },
  balanced: { costPreset: 'standard', tickIntervalMins: '30', dailySpendBudgetUsd: '10', riskTolerance: 'moderate',    openPositionEscalationToJudgePolicy: 'uncovered_or_triggered' },
  bold:     { costPreset: 'premium',  tickIntervalMins: '10', dailySpendBudgetUsd: '30', riskTolerance: 'aggressive',  openPositionEscalationToJudgePolicy: 'always' },
};

export function resolveStyleDefaults(style: AgentStyleValue): StyleDefaults {
  const config = STYLE_CONFIG[style];
  if (!config) {
    return STYLE_CONFIG.balanced;
  }
  return config;
}

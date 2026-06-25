export type AgentStyleValue = 'careful' | 'balanced' | 'bold';

export interface StyleDefaults {
  costPreset: 'minimal' | 'standard' | 'premium';
  tickIntervalMins: string;
  dailySpendBudgetUsd: string;
  riskTolerance: 'conservative' | 'moderate' | 'aggressive';
}

export const STYLE_CONFIG: Record<AgentStyleValue, StyleDefaults> = {
  careful:  { costPreset: 'minimal',  tickIntervalMins: '60', dailySpendBudgetUsd: '3',  riskTolerance: 'conservative' },
  balanced: { costPreset: 'standard', tickIntervalMins: '30', dailySpendBudgetUsd: '10', riskTolerance: 'moderate' },
  bold:     { costPreset: 'premium',  tickIntervalMins: '15', dailySpendBudgetUsd: '30', riskTolerance: 'aggressive' },
};

export function resolveStyleDefaults(style: AgentStyleValue): StyleDefaults {
  const config = STYLE_CONFIG[style];
  if (!config) {
    return STYLE_CONFIG.balanced;
  }
  return config;
}

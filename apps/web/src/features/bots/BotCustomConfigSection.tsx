export interface BotCustomConfigFormState {
  // Strategy identity
  strategyType: 'momentum' | 'range' | 'contrarian' | 'swing' | 'scalper';
  decisionMode: 'mechanical'; // only mechanical in v1; llm/hybrid deferred

  // Signal interpretation (mechanical params)
  signalBias: 'trend-following' | 'mean-reverting';
  candleInterval: '5m' | '15m' | '1H' | '4H' | '1D';
  candleLimit: string; // controlled number input → parseInt

  // Exit targets (mechanical params — both required for mechanical strategy)
  stopLossPct: string;
  takeProfitPct: string;
  trailingStopPct: string; // empty string = null (no trailing stop)

  // Position sizing (mechanical params)
  positionSize: string;
  positionSizeMode: 'fixed' | 'percent_equity';

  // Risk guardrails (all optional — only sent when non-empty)
  maxPositionSizePct: string;
  maxOpenPositions: string;
  dailyMaxLossPct: string;
  stopLossMaxUnrealizedLossPct: string;
}

export const defaultBotCustomConfig: BotCustomConfigFormState = {
  strategyType: 'momentum',
  decisionMode: 'mechanical',
  signalBias: 'trend-following',
  candleInterval: '15m',
  candleLimit: '48',
  stopLossPct: '',
  takeProfitPct: '',
  trailingStopPct: '',
  positionSize: '100',
  positionSizeMode: 'percent_equity',
  maxPositionSizePct: '',
  maxOpenPositions: '',
  dailyMaxLossPct: '',
  stopLossMaxUnrealizedLossPct: '',
};

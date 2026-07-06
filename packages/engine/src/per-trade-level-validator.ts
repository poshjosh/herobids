import type { Price } from '@herobids/domain';

export interface LevelValidationInput {
  side: 'long' | 'short';
  markPrice: Price;
  stopLoss?: Price;
  takeProfit?: Price;
}

export type LevelValidationError =
  | { field: 'stopLoss'; reason: 'above_mark_for_long' | 'below_mark_for_short'; markPrice: string; level: string }
  | { field: 'takeProfit'; reason: 'below_mark_for_long' | 'above_mark_for_short'; markPrice: string; level: string };

export function validatePerTradeLevels(input: LevelValidationInput): LevelValidationError | null {
  if (input.stopLoss) {
    if (input.side === 'long' && input.stopLoss.gte(input.markPrice)) {
      return { field: 'stopLoss', reason: 'above_mark_for_long', markPrice: input.markPrice.toString(), level: input.stopLoss.toString() };
    }
    if (input.side === 'short' && input.stopLoss.lte(input.markPrice)) {
      return { field: 'stopLoss', reason: 'below_mark_for_short', markPrice: input.markPrice.toString(), level: input.stopLoss.toString() };
    }
  }
  if (input.takeProfit) {
    if (input.side === 'long' && input.takeProfit.lte(input.markPrice)) {
      return { field: 'takeProfit', reason: 'below_mark_for_long', markPrice: input.markPrice.toString(), level: input.takeProfit.toString() };
    }
    if (input.side === 'short' && input.takeProfit.gte(input.markPrice)) {
      return { field: 'takeProfit', reason: 'above_mark_for_short', markPrice: input.markPrice.toString(), level: input.takeProfit.toString() };
    }
  }
  return null;
}

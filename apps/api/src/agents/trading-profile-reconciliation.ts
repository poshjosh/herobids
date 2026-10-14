// Re-export shim: the module moved to @herobids/db. Importers should switch to @herobids/db.
export {
  buildTradingProfileSnapshots,
  overlayTradingProfile,
  planTradingProfileReconciliation,
  proposeTradingProfiles,
  selectExecutionBinding,
} from '@herobids/db';
export type {
  ExecutionBinding,
  TradingProfileChanges,
  TradingProfileConfiguration,
  TradingProfileConnection,
  TradingProfileInverseAction,
  TradingProfileReconciliationPlan,
  TypedTradingProfile,
} from '@herobids/db';

/**
 * UUIDv7 — time-ordered, globally unique identifier.
 * Branded type prevents accidental mixing of IDs from different entities.
 */

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type OrderId = Brand<string, 'OrderId'>;
export type BotId = Brand<string, 'BotId'>;
// PortfolioId REMOVED — portfolios dropped from MVP
export type VenueAccountId = Brand<string, 'VenueAccountId'>;
export type InstrumentId = Brand<string, 'InstrumentId'>;
export type DecisionId = Brand<string, 'DecisionId'>;
export type FillId = Brand<string, 'FillId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type SkillId = Brand<string, 'SkillId'>;

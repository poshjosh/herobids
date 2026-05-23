/**
 * UUIDv7 — time-ordered, globally unique identifier.
 * Branded type prevents accidental mixing of IDs from different entities.
 */

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type OrderId = Brand<string, 'OrderId'>;
export type TradingInstanceId = Brand<string, 'TradingInstanceId'>;
export type PortfolioId = Brand<string, 'PortfolioId'>;
export type VenueAccountId = Brand<string, 'VenueAccountId'>;
export type InstrumentId = Brand<string, 'InstrumentId'>;
export type DecisionId = Brand<string, 'DecisionId'>;
export type FillId = Brand<string, 'FillId'>;

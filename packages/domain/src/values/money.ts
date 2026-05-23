import Decimal from 'decimal.js';

/** A monetary price (always use decimal.js, never floating point). */
export type Price = Decimal;

/** A quantity/size (always use decimal.js, never floating point). */
export type Quantity = Decimal;

/** Convenience constructors */
export function price(value: string | number): Price {
  return new Decimal(value);
}

export function quantity(value: string | number): Quantity {
  return new Decimal(value);
}

/** Re-export Decimal class for packages that need direct access */
export { Decimal };

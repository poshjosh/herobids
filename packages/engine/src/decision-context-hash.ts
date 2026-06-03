import crypto from 'node:crypto';
import type { DecisionContext } from './decision-intake.js';

export const DECISION_CONTEXT_HASH_MISMATCH_CODE = 'decision.context_hash_mismatch' as const;

export class DecisionContextHashMismatchError extends Error {
  readonly code = DECISION_CONTEXT_HASH_MISMATCH_CODE;

  constructor(
    public readonly expectedHash: string,
    public readonly suppliedHash: string,
  ) {
    super('Decision context hash does not match the resolved server context');
    this.name = 'DecisionContextHashMismatchError';
  }
}

export function computeDecisionContextHash(context: DecisionContext): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalizeForHash(context)))
    .digest('hex')
    .slice(0, 16);
}

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForHash(item));
  }

  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value as object) as unknown;
    if (proto === Object.prototype || proto === null) {
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const result: Record<string, unknown> = {};

      for (const [key, childValue] of entries) {
        const normalizedValue = canonicalizeForHash(childValue);
        if (normalizedValue !== undefined) {
          result[key] = normalizedValue;
        }
      }

      return result;
    }
  }

  return value;
}
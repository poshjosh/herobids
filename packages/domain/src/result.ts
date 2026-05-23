/**
 * Result type for package boundary returns.
 * Public APIs never throw — they return Result.
 */
export type Result<T, E = DomainError> =
  | { ok: true; data: T }
  | { ok: false; error: E };

export interface DomainError {
  /** Dot-namespaced code, e.g. "venue.timeout" */
  code: string;
  /** Human-readable description */
  message: string;
  /** Optional structured metadata */
  context?: Record<string, unknown>;
}

/** Helper to create a success result */
export function ok<T>(data: T): Result<T, never> {
  return { ok: true, data };
}

/** Helper to create a failure result */
export function err<E = DomainError>(error: E): Result<never, E> {
  return { ok: false, error };
}

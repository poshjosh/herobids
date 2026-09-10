// The Traderton consumer boundary contract (005-consumer-boundary-contract.md).
//
// These types mirror the boundary envelope, terminal result, and status shapes
// EXACTLY as authored on the Traderton side. They are the wire contract herobids
// speaks over REST — transport/envelope/mapping only, no trading behaviour.
//
// Kept strict: no `any`, unknown-typed payloads at the boundary are the tool's
// concern (Traderton owns the per-tool schema), so `payload` is `unknown` here
// and callers narrow it.

/** Actor provenance the boundary authorizes against (mirrors 005 §Invocation Contract). */
export type TradertonActorType = 'agent' | 'bot' | 'user' | 'system';

/** The caller identity carried in the envelope AND signed headers (they must match). */
export interface TradertonCaller {
  consumerId: string;
  keyId: string;
}

/** The subject (owner + actor) the platform injects at the call site. */
export interface TradertonSubject {
  ownerId: string;
  actor: { type: TradertonActorType; id: string };
}

/** The 005 invocation envelope — generic over `toolName` + `payload`. */
export interface TradertonToolInvocationV1 {
  contractVersion: '1.0';
  requestId: string;
  idempotencyKey: string;
  correlationId: string;
  issuedAt: string;
  deadlineAt: string;
  caller: TradertonCaller;
  subject: TradertonSubject;
  toolName: string;
  payload: unknown;
}

/**
 * The closed failure-code union (005 §Consumer Result Mapping). Kept as a literal
 * union so callers can exhaustively branch; consumers must preserve `retryable`
 * rather than deriving it from the code.
 */
export type TradertonBoundaryFailureCode =
  | 'validation.invalid_payload'
  | 'authentication.invalid_caller'
  | 'authorization.denied'
  | 'not_found.resource'
  | 'precondition.not_ready'
  | 'rate_limit.exceeded'
  | 'deadline.expired'
  | 'upstream.transient'
  | 'internal.non_retryable'
  | 'contract.unsupported_version';

/** A terminal success outcome. */
export interface TradertonSuccessOutcome {
  kind: 'success';
  payload: unknown;
}

/** A terminal failure outcome — `code` + `retryable` are preserved verbatim. */
export interface TradertonFailureOutcome {
  kind: 'failure';
  code: TradertonBoundaryFailureCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type TradertonOutcome = TradertonSuccessOutcome | TradertonFailureOutcome;

/** The 005 terminal result shape. */
export interface TradertonToolResultV1 {
  contractVersion: '1.0';
  requestId: string;
  correlationId: string;
  outcome: TradertonOutcome;
}

/** The 005 invocation-status shape (returned by invoke on idempotency reuse, or by GET status). */
export type TradertonToolInvocationStatusV1 =
  | {
      contractVersion: '1.0';
      requestId: string;
      correlationId: string;
      state: 'in_progress';
    }
  | {
      contractVersion: '1.0';
      requestId: string;
      correlationId: string;
      state: 'terminal';
      result: TradertonToolResultV1;
    };

/** The boundary REST endpoints (paths only — no query strings, per 005 §Authentication). */
export const TRADERTON_INVOKE_PATH = '/internal/v1/tools:invoke';
export const TRADERTON_STATUS_PATH_PREFIX = '/internal/v1/invocations/';

/** Build the status path for a given requestId (path only, no query string). */
export function tradertonStatusPath(requestId: string): string {
  return `${TRADERTON_STATUS_PATH_PREFIX}${encodeURIComponent(requestId)}`;
}

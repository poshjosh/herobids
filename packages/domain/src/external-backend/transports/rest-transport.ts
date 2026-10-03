// The REST transport (005-consumer-boundary-contract.md): signed
// `POST tools:invoke` and `GET invocations/:requestId`. The request bytes are
// FROZEN (Step 10 plan §5) and pinned by the signing vectors: the envelope is
// handed to `signInvoke` as built, so its JSON key order is unchanged.

import { signInvoke, signStatus, type SigningIdentity } from '../sign.js';
import {
  EXTERNAL_BACKEND_INVOKE_PATH,
  externalBackendStatusPath,
  type ExternalBackendOutcome,
  type ExternalBackendToolInvocationStatusV1,
  type ExternalBackendToolResultV1,
} from '../contract.js';
import type {
  ExternalBackendTransport,
  TransportAttempt,
  TransportInvocation,
  TransportOutcome,
  TransportStatusAttempt,
} from './transport.js';

export interface RestTransportOptions {
  /** Already trimmed of trailing slashes by the client. */
  baseUrl: string;
  identity: SigningIdentity;
}

const UNRECOGNISED_STATUS_MESSAGE = 'boundary returned an unrecognised status response';
const UNRECOGNISED_RESPONSE_MESSAGE = 'boundary returned an unrecognised response';

// invoke and lookupStatus read unvalidated JSON, so they check shape before
// decoding: a body they do not recognise is a transport fault, never a
// TypeError thrown out. A status body must carry one of the two known states.
function hasStringIds(value: object): boolean {
  return (
    'requestId' in value &&
    typeof value.requestId === 'string' &&
    'correlationId' in value &&
    typeof value.correlationId === 'string'
  );
}

function isStatusBody(value: unknown): value is ExternalBackendToolInvocationStatusV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    hasStringIds(value) &&
    'state' in value &&
    (value.state === 'in_progress' || value.state === 'terminal')
  );
}

function isOutcome(value: unknown): value is ExternalBackendOutcome {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  // No `payload` check: the backend's `successResult(identity, result.data)`
  // may carry `undefined`, which JSON drops, so an absent key is a valid success.
  if (value.kind === 'success') return true;
  return (
    value.kind === 'failure' &&
    'code' in value &&
    typeof value.code === 'string' &&
    'message' in value &&
    typeof value.message === 'string' &&
    'retryable' in value &&
    typeof value.retryable === 'boolean'
  );
}

function isToolResultBody(value: unknown): value is ExternalBackendToolResultV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    hasStringIds(value) &&
    'outcome' in value &&
    isOutcome(value.outcome)
  );
}

function transportError(message: string): TransportOutcome {
  return { kind: 'transport_error', message };
}

function terminal(result: ExternalBackendToolResultV1): TransportOutcome {
  return { kind: 'terminal', result };
}

export class RestTransport implements ExternalBackendTransport {
  private readonly baseUrl: string;
  private readonly identity: SigningIdentity;

  constructor(options: RestTransportOptions) {
    this.baseUrl = options.baseUrl;
    this.identity = options.identity;
  }

  async invoke(invocation: TransportInvocation, attempt: TransportAttempt): Promise<TransportOutcome> {
    const { headers, rawBody } = signInvoke(this.identity, EXTERNAL_BACKEND_INVOKE_PATH, invocation);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${EXTERNAL_BACKEND_INVOKE_PATH}`, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(attempt.timeoutMs),
      });
    } catch {
      return transportError('request to boundary failed');
    }

    if (!response.ok) {
      return transportError(`boundary returned status ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return transportError('boundary returned an unreadable response');
    }

    if (isStatusBody(body)) {
      if (body.state === 'in_progress') {
        return { kind: 'in_progress', requestId: body.requestId, correlationId: body.correlationId };
      }
      return isToolResultBody(body.result) ? terminal(body.result) : transportError(UNRECOGNISED_RESPONSE_MESSAGE);
    }
    return isToolResultBody(body) ? terminal(body) : transportError(UNRECOGNISED_RESPONSE_MESSAGE);
  }

  async lookupStatus(requestId: string, attempt: TransportStatusAttempt): Promise<TransportOutcome> {
    const path = externalBackendStatusPath(requestId);
    const headers = signStatus(this.identity, path, { deadlineAt: attempt.deadlineAt });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(attempt.timeoutMs),
      });
    } catch {
      return transportError('status request to boundary failed');
    }

    if (!response.ok) {
      return transportError(`boundary returned status ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return transportError('boundary returned an unreadable status response');
    }

    if (!isStatusBody(body)) {
      // A plain result (no `state`) is the boundary answering for the lookup
      // itself — e.g. `not_found.resource` when it has no record of the
      // requestId. It is terminal: return it rather than polling to the deadline.
      // An unknown `state` is unrecognised, never polled to the deadline.
      return isToolResultBody(body) ? terminal(body) : transportError(UNRECOGNISED_STATUS_MESSAGE);
    }
    if (body.state === 'terminal') {
      return isToolResultBody(body.result) ? terminal(body.result) : transportError(UNRECOGNISED_STATUS_MESSAGE);
    }
    return { kind: 'in_progress', requestId: body.requestId, correlationId: body.correlationId };
  }
}

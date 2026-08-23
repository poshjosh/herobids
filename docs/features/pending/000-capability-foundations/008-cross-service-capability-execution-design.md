# Cross-Service Capability Execution Design

**Status:** proposed  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Applies to:** `crypto-trading` and `messaging`

## Purpose

Define the single production boundary through which Agent Core invokes a
capability-owned tool. This document is normative for both capability-service
extractions. A service is not considered extracted until it implements this
contract and the operational requirements below.

## Decisions

1. Tool invocation uses synchronous HTTPS JSON over the private service
   network. It does not use Redis, a worker-local import, or an asynchronous
   command topic as its execution transport.
2. The caller is Agent Core, currently hosted by `apps/worker`. The caller
   selects the target service from the capability registry and invokes the
   service through its configured private base URL.
3. Each capability service exposes the same versioned endpoint:

   ```text
   POST /internal/v1/capability-tools:invoke
   GET  /internal/v1/capability-tools/invocations/:requestId
   GET  /health/live
   GET  /health/ready
   ```

4. The invocation endpoint is the only execution entry point. The status
   endpoint is for resolving an ambiguous caller timeout with the original
   `requestId`; it must never cause execution.
5. Capability services publish completion audit events only after their durable
   invocation record reaches a terminal state:

   ```text
   capability.crypto-trading.tool-invocation.completed.v1
   capability.messaging.tool-invocation.completed.v1
   ```

   These events are observational. They never initiate or retry a tool call.

## Packages, Applications, And Ownership

| Area | Location | Responsibility |
| --- | --- | --- |
| Shared DTOs and Zod schemas | `packages/domain/src/capability-tool-contract.ts` | Versioned envelope, terminal result, error codes, and validation schemas. |
| Agent Core invocation client | `apps/worker/src/capability-invocation/` | Target selection, signing, deadline enforcement, retry policy, and mapping to `ToolResult`. |
| Trading capability service | `apps/crypto-trading/` | Trading-owned tools, trading readiness, invocation store, and handoff to the authoritative trading instance. |
| Messaging capability service | `apps/messaging/` | Messaging-owned tools, delivery routing, invocation store, and delivery state. |
| Registry and ownership manifest | `packages/domain/src/capability-registry.ts` and `packages/domain/src/tool-ownership.ts` | Static product metadata only. |

Neither capability service may import implementation code from `apps/worker`.
Agent Core may import only the shared contract types and its invocation-client
abstraction; it must not import capability implementation modules.

## Invocation Contract

`packages/domain/src/capability-tool-contract.ts` must export Zod schemas and
inferred types for the following JSON envelope. JSON uses camelCase keys,
RFC 3339 UTC timestamps, and decimal values represented as strings where the
existing tool schema requires exact decimal values.

```ts
type CapabilityToolInvocationV1 = {
  contractVersion: '1.0';
  requestId: string; // UUID generated once per Agent Core tool invocation
  idempotencyKey: string; // UUID stable for all retries of this invocation
  correlationId: string;
  issuedAt: string;
  deadlineAt: string;
  caller: {
    serviceId: 'agent-core';
    keyId: string;
  };
  authorization: {
    tenantId: string;
    agentId: string;
    sessionId: string;
    actor: { type: 'agent' | 'bot' | 'user' | 'system'; id: string };
    capabilityId: 'crypto-trading' | 'messaging';
    activationVersion: number;
  };
  capabilityId: 'crypto-trading' | 'messaging';
  toolName: string;
  payload: unknown;
};
```

The service must validate the envelope first, then validate `toolName` and the
tool payload with the same Zod schema used to publish that tool to the LLM. An
unknown tool, a tool not owned by the receiving capability, or a payload that
does not parse is a terminal validation failure. Services must reject unknown
keys in the outer invocation envelope; individual tool schemas retain their
existing intentional passthrough behavior only where explicitly declared.

The terminal response is:

```ts
type CapabilityToolResultV1 = {
  contractVersion: '1.0';
  requestId: string;
  correlationId: string;
  outcome:
    | { kind: 'success'; payload: unknown }
    | {
        kind: 'failure';
        code: CapabilityToolFailureCode;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown>;
      };
};
```

`CapabilityToolFailureCode` is a closed union:

```text
validation.invalid_payload
authentication.invalid_caller
authorization.denied
not_found.resource
precondition.not_ready
precondition.capability_inactive
rate_limit.exceeded
deadline.expired
upstream.transient
internal.non_retryable
contract.unsupported_version
```

## Version Compatibility

1. The path major version and `contractVersion` major version must match.
   `/internal/v1/...` accepts only `contractVersion: '1.0'` initially.
2. Minor releases may add optional fields and error-detail properties only.
   They must not change the meaning, requiredness, or type of existing fields.
3. A caller must send the oldest supported minor version. A service must return
   `contract.unsupported_version` before executing if the version is not
   supported.
4. A breaking change requires `/internal/v2/...`, a new contract literal, and
   a migration plan that runs both majors until all callers migrate.

## Authentication And Authorization

Every request is authenticated with an HMAC-SHA-256 service signature. The
signature covers this exact canonical string:

```text
METHOD + "\n" + PATH + "\n" + X-Herobids-Timestamp + "\n" + SHA256(raw JSON body)
```

Required headers are:

```text
Content-Type: application/json
X-Herobids-Service-Id: agent-core
X-Herobids-Key-Id: <active key identifier>
X-Herobids-Timestamp: <RFC 3339 UTC>
X-Herobids-Signature: sha256=<hex digest>
X-Request-Deadline-At: <same value as body.deadlineAt>
```

Service credentials are operator secrets. They are referenced, never stored,
in configuration. A receiving service accepts only configured caller IDs and
key IDs, rejects timestamps outside the configured clock-skew window, and uses
constant-time signature comparison. Private-network placement is defense in
depth, not an authentication substitute.

The receiving service authorizes only after authentication. It must verify:

1. `caller.serviceId` is authorized for the requested capability;
2. URL target, `capabilityId`, and manifest ownership of `toolName` agree;
3. the request contains non-empty tenant, agent, session, and actor identity;
4. actor provenance is valid for the requested tool; and
5. its capability-local readiness/binding policy allows the action.

Agent Core is the authority for user ownership, session ownership, resolved
skills, and capability activation at dispatch time. The signed service request
is its authorization assertion. Capability services must not accept a
user-originated HTTP request or trust an unsigned identity field.

## Deadlines, Retries, And Idempotency

Agent Core sets `deadlineAt` from its resolved operator transport timeout before
the request is sent. It must not dispatch a request after the deadline. The
service rejects a request whose deadline has passed before validation, and
checks it again immediately before every external or trading-instance side
effect.

Only Agent Core retries transport failures. It may retry only when all of these
are true:

1. the deadline has not expired;
2. no terminal response was received; and
3. the same `requestId` and `idempotencyKey` are reused.

Capability services may retry a provider call internally only when the provider
operation is idempotent under the same persisted invocation key. They own
provider-specific retry limits and must stop before `deadlineAt`.

Each service persists `capability_tool_invocations` before any side effect. Its
unique key is:

```text
(capability_id, tenant_id, agent_id, tool_name, idempotency_key)
```

The record stores a SHA-256 request fingerprint, request ID, correlation ID,
state, terminal response, timestamps, and expiry. A reused key with a different
fingerprint returns `validation.invalid_payload`; a reused key with the same
fingerprint returns the original terminal result or its in-progress status.

The default retention is configured as
`capabilityTransport.idempotencyRetentionHours: 168`. The implementation may
not hard-code a retention period. Expired records are purged asynchronously;
the purge loop must reschedule or fail visibly.

For `submit_decision`, the durable invocation and the trading-instance handoff
must share the idempotency key. For `send_message` and `send_email`, the durable
invocation must be written before creating an outbound-message or provider-send
attempt. This preserves intent before side effects and makes ambiguous timeouts
reconcilable.

## Mapping To Agent Tool Results

| Contract outcome | Agent `ToolResult` |
| --- | --- |
| success | `{ success: true, data: payload }` |
| `validation.invalid_payload`, `not_found.resource`, `precondition.*`, `rate_limit.exceeded`, `contract.unsupported_version` | `{ success: false, fault: false, retryable: false, errorCode: code, error: message }` |
| `authentication.invalid_caller`, `authorization.denied` | `{ success: false, fault: true, retryable: false, errorCode: code, error: message }` and a security log |
| `deadline.expired` | `{ success: false, fault: false, retryable: false, errorCode: code, error: message }` |
| `upstream.transient` | `{ success: false, fault: true, retryable: true, errorCode: code, error: message }` |
| `internal.non_retryable` | `{ success: false, fault: true, retryable: false, errorCode: code, error: message }` |

The LLM never receives service credentials, raw provider errors, stack traces,
or internal authorization details.

## Configuration

Generic caller transport configuration belongs in the resolved operator config:

```yaml
capabilityTransport:
  requestTimeoutMs: 10000
  clockSkewMs: 30000
  idempotencyRetentionHours: 168
  services:
    cryptoTrading:
      baseUrl: http://crypto-trading:3101
    messaging:
      baseUrl: http://messaging:3102
  credentials:
    agentCore:
      keyId: current
      secretRef: ${CAPABILITY_AGENT_CORE_SIGNING_SECRET_REF}
```

`requestTimeoutMs`, skew, and retention require Zod validation and defaults in
the config schema. Capability-domain configuration is private to each service:

```text
config/capabilities/crypto-trading.yaml
config/capabilities/messaging.yaml
```

Each service loads and validates only its own file plus the generic transport
credential reference required to verify Agent Core. Capability settings must not
be added to Agent Core's user/instance config.

## Deployment And Health

The root Dockerfile gains `build-crypto-trading`, `build-messaging`,
`crypto-trading`, and `messaging` targets. `docker-compose.yaml` adds
`crypto-trading` and `messaging` services on the private default network. They
depend on `migrate`, PostgreSQL, and Redis only where their own implementation
requires them. API and worker use service names and never localhost URLs.

Health semantics are fixed:

1. `/health/live` confirms that the process can serve requests.
2. `/health/ready` confirms that configuration, contract validation, required
   persistence, and mandatory provider dependencies for the service are ready.
3. The capability resolver reports service health separately from provider
   lifecycle and tenant readiness.
4. When a capability service is not ready, Agent Core removes its owned tools
   from new runtime visibility snapshots and returns a degraded reason. It does
   not fall back to the old in-process implementation.
5. An in-flight invocation returns `upstream.transient` or `deadline.expired`
   according to the observed outcome. The caller resolves ambiguity by retrying
   with the same key or querying the status endpoint. It never emits a second
   new idempotency key for the same LLM tool call.

## Required Verification

The extraction phase is complete only after automated tests prove:

1. valid signed calls succeed and invalid, expired, replayed, or unauthorized
   signatures fail before execution;
2. malformed envelopes and payloads produce typed validation failures;
3. deadline expiry prevents side effects;
4. retrying a side-effecting call with the same key yields one persisted
   invocation and one downstream effect;
5. a different payload with the same key is rejected;
6. unhealthy service readiness removes tools and prevents an in-process
   fallback; and
7. compose starts both services and their readiness endpoints become healthy.
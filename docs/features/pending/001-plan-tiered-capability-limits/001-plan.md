# Plan-Tiered Capability, Sandbox, and Tool Argument Limits

**Status:** Draft
**Created:** 2026-08-29
**Area:** Agent runtime, operator config, plan entitlements

---

## Problem Statement

All agents currently share identical hardcoded capability limits (`DEFAULT_CAPABILITY_GRANTS` in `capability-policy.ts`), sandbox resource defaults (`sandboxDefaults`), and tool argument limits regardless of the owner's subscription plan. The operator has no config-driven way to differentiate limits by tier — the only override path is per-agent `toolPolicy` JSONB, which has no ceiling enforcement.

This means:
- A free-tier user's agent gets the same `execute_code` rate (5/min) as a pro user's.
- There is no operator config surface for capability grants — defaults are code literals.
- Tool argument limits (max code length, max dependencies, max query length) don't exist.
- Per-agent `toolPolicy` overrides can exceed what the plan should allow.

## Goals

1. **Operator config for capability defaults** — move `DEFAULT_CAPABILITY_GRANTS` from code into `config/default.yaml` under `agentRuntime.capabilityDefaults`.
2. **Plan-tiered capability grants** — each plan tier defines its own capability limits under `plans.<planId>.entitlements.capabilities`.
3. **Plan-tiered sandbox limits** — extend `resourceProfiles` to include sandbox enforcer limits (not just container resource limits).
4. **Plan-tiered tool argument limits** — add configurable argument constraints (max code length, max dependency count, max query length) that vary by tier.
5. **Ceiling enforcement** — operator config defines absolute ceilings; plan grants cannot exceed them; per-agent `toolPolicy` cannot exceed plan grants.

## Non-Goals

- Per-user (non-plan) capability overrides via API (future feature).
- Hot-reload of plan changes to running agent sessions — v1 requires agent restart (see I2 in Implementation Details).
- New billing/metering for tool invocations (existing usage billing handles cost).
- Capability foundations / service extraction (separate feature: `pending/000-capability-foundations`).
- Capability policy for filesystem tools (`list_files`, `read_file`, `delete_file`) — these are workspace-scoped and low-risk (see D2 in Decisions).

---

## Design

### Resolution Order (most restrictive wins)

```
Operator ceiling (agentRuntime.capabilityDefaults)
  ↓ min()
Plan-tier entitlements (plans.<planId>.entitlements.capabilities.<capability>)
  ↓ min()
Per-agent overrides (agents.toolPolicy JSONB)
  = Effective capability grants for this agent session
```

For each numeric limit field, the effective value is:
```
effective = min(operatorCeiling, planTierValue ?? operatorCeiling, agentOverride ?? planTierValue ?? operatorCeiling)
```

For boolean fields (`enabled`), all three layers must agree — any `false` wins.

### Config Schema Changes

#### 1. Operator capability defaults (`agentRuntime.capabilityDefaults`)

Replaces the hardcoded `DEFAULT_CAPABILITY_GRANTS` array. Lives under `agentRuntime` because it is operator config (deploy/restart lifecycle), not instance config.

```yaml
# config/default.yaml
agentRuntime:
  capabilityDefaults:
    execute_code:
      enabled: true
      tier: direct
      limits:
        maxPerMinute: 20        # operator ceiling
        maxConcurrent: 2
        timeoutMs: 120000
        maxResponseBytes: 1048576
      argumentLimits:
        maxCodeBytes: 102400    # 100 KB
        maxDependencies: 10
    search_web:
      enabled: true
      tier: direct
      limits:
        maxPerMinute: 30
        maxConcurrent: 5
        timeoutMs: 20000
        maxResponseBytes: 262144
      argumentLimits:
        maxQueryLength: 400
        maxResults: 10
    browse_url:
      enabled: true
      tier: direct
      limits:
        maxPerMinute: 30
        maxConcurrent: 5
        timeoutMs: 20000
        maxResponseBytes: 524288
    submit_decision:
      enabled: true
      tier: brokered
      limits:
        maxPerMinute: 20
        maxConcurrent: 2
        timeoutMs: 30000
    send_message:
      enabled: true
      tier: brokered
      limits:
        maxPerMinute: 20
        maxConcurrent: 5
        timeoutMs: 10000
    publish_artifact:
      enabled: true
      tier: brokered
      limits:
        maxPerMinute: 30
        maxConcurrent: 5
        timeoutMs: 10000
    manage_bot:
      enabled: false            # off by default, enabled per-plan
      tier: brokered
      limits:
        maxPerMinute: 10
        maxConcurrent: 2
        timeoutMs: 30000
    bot_query:
      enabled: true
      tier: brokered
      limits:
        maxPerMinute: 30
        maxConcurrent: 3
        timeoutMs: 30000
    assess_strategy_preset:
      enabled: true
      tier: brokered
      limits:
        maxPerMinute: 10
        maxConcurrent: 2
        timeoutMs: 60000
    change_strategy_preset:
      enabled: true
      tier: brokered
      limits:
        maxPerMinute: 10
        maxConcurrent: 1
        timeoutMs: 30000
    manage_agent_skills:
      enabled: true
      tier: brokered
      limits:
        maxPerMinute: 10
        maxConcurrent: 1
        timeoutMs: 30000
    read_document:
      enabled: true
      tier: direct
      limits:
        maxPerMinute: 30
        maxConcurrent: 5
        timeoutMs: 20000
        maxResponseBytes: 524288
    # 'never' tier capabilities — cannot be enabled by any plan or override
    venue_api:
      enabled: false
      tier: never
    raw_secrets:
      enabled: false
      tier: never
    database_write:
      enabled: false
      tier: never
    host_control:
      enabled: false
      tier: never
```

#### 2. Plan-tier capability entitlements (`plans.<planId>.entitlements.capabilities`)

Each plan defines overrides for specific capabilities. Omitted capabilities inherit the operator default. Numeric values are capped at the operator ceiling.

```yaml
plans:
  plans:
    free:
      entitlements:
        # ... existing entitlements (skills, agents, blueprints, limits) ...
        capabilities:
          execute_code:
            limits:
              maxPerMinute: 5
              maxConcurrent: 1
              maxInvocations: 50           # per-session cap (see D4)
              timeoutMs: 60000
              maxResponseBytes: 524288     # 512 KB
            argumentLimits:
              maxCodeBytes: 51200          # 50 KB
              maxDependencies: 5
          search_web:
            limits:
              maxPerMinute: 10
              maxConcurrent: 3
              timeoutMs: 15000
            argumentLimits:
              maxResults: 5
          browse_url:
            limits:
              maxPerMinute: 10
              maxConcurrent: 3
              maxResponseBytes: 262144     # 256 KB
          submit_decision:
            limits:
              maxPerMinute: 10
              maxConcurrent: 1
          manage_bot:
            enabled: false                 # bots not available on free
        sandbox:
          maxRequestsPerMinute: 30
          maxConcurrentConnections: 5
          maxResponseBytes: 5242880        # 5 MB
          maxTotalDownloadBytes: 52428800   # 50 MB

    starter:
      entitlements:
        capabilities:
          execute_code:
            limits:
              maxPerMinute: 10
              maxConcurrent: 1
              maxInvocations: 200          # per-session cap (see D4)
              timeoutMs: 90000
              maxResponseBytes: 1048576    # 1 MB
            argumentLimits:
              maxCodeBytes: 102400         # 100 KB
              maxDependencies: 10
          search_web:
            limits:
              maxPerMinute: 20
              maxConcurrent: 3
            argumentLimits:
              maxResults: 10
          browse_url:
            limits:
              maxPerMinute: 20
              maxConcurrent: 3
              maxResponseBytes: 524288     # 512 KB
          submit_decision:
            limits:
              maxPerMinute: 15
              maxConcurrent: 1
          manage_bot:
            enabled: true
            limits:
              maxPerMinute: 5
              maxConcurrent: 1
        sandbox:
          maxRequestsPerMinute: 60
          maxConcurrentConnections: 10
          maxResponseBytes: 10485760       # 10 MB
          maxTotalDownloadBytes: 104857600  # 100 MB

    pro:
      entitlements:
        capabilities:
          execute_code:
            limits:
              maxPerMinute: 20
              maxConcurrent: 2
              timeoutMs: 120000
              maxResponseBytes: 1048576
            argumentLimits:
              maxCodeBytes: 102400
              maxDependencies: 10
          search_web:
            limits:
              maxPerMinute: 30
              maxConcurrent: 5
            argumentLimits:
              maxResults: 10
          browse_url:
            limits:
              maxPerMinute: 30
              maxConcurrent: 5
              maxResponseBytes: 524288
          submit_decision:
            limits:
              maxPerMinute: 20
              maxConcurrent: 2
          manage_bot:
            enabled: true
            limits:
              maxPerMinute: 10
              maxConcurrent: 2
        sandbox:
          maxRequestsPerMinute: 60
          maxConcurrentConnections: 10
          maxResponseBytes: 10485760
          maxTotalDownloadBytes: 104857600
```

#### 3. Plan-tier sandbox limits (`plans.<planId>.entitlements.sandbox`)

Sandbox enforcer limits that are plan-specific, separate from container resource profiles (which already exist in `resourceProfiles`). These control in-process enforcement: outbound request rate, connection concurrency, response size, and download budgets.

Resolution: `effective = min(sandboxDefaults, planTierSandbox ?? sandboxDefaults)`.

The existing `resourceProfiles` (container-level: memoryLimitMb, cpuShares, maxProcesses, tempStorageMb) remain as they are. Sandbox limits (in-process: maxRequestsPerMinute, maxConcurrentConnections, maxResponseBytes, maxTotalDownloadBytes) move to the plan entitlements with `sandboxDefaults` as the operator ceiling.

#### 4. Tool argument limits (`argumentLimits`)

New per-capability field alongside `limits`. Enforced at parameter validation time, before the capability policy rate/concurrency check.

| Capability | Argument Limit | Description |
|---|---|---|
| `execute_code` | `maxCodeBytes` | Max size of the `code` parameter in bytes |
| `execute_code` | `maxDependencies` | Max entries in the `dependencies` array |
| `search_web` | `maxQueryLength` | Max character length of the `query` parameter |
| `search_web` | `maxResults` | Max value for the `maxResults` parameter |
| `browse_url` | (none initially) | URL length is already bounded by practical limits |

Argument limits are optional — omitted fields mean "no additional restriction beyond the Zod schema default."

---

## Implementation Phases

### Phase 1: Operator Config for Capability Defaults

**Effort:** ~1 day
**Risk:** Low (additive, no behavior change if defaults match current hardcoded values)
**Implements:** D1 (read_document gets own grant), D3 (manage_bot plan + skill layering)

**Files modified:**
- `packages/domain/src/config/schema.ts` — Add `CapabilityDefaultsSchema`, `ArgumentLimitsSchema`, `PlanCapabilityEntitlementsSchema`, `PlanSandboxEntitlementsSchema`. Extend `AgentRuntimeConfigSchema` with `capabilityDefaults`. Extend `PlanEntitlementsSchema` with `capabilities` and `sandbox`.
- `config/default.yaml` — Add `agentRuntime.capabilityDefaults` section with current hardcoded values. Add `read_document` as its own capability (same defaults as `browse_url`, see D1). Set `manage_bot.enabled: false` at operator level (plan tier enables it for starter/pro, see D3).
- `apps/worker/src/agents/capability-policy.ts` — Replace `DEFAULT_CAPABILITY_GRANTS` array with a `buildDefaultCapabilityGrants(config)` function that reads from the config.

**Acceptance criteria:**
- `DEFAULT_CAPABILITY_GRANTS` is derived from `agentRuntime.capabilityDefaults` config, not hardcoded.
- Changing `capabilityDefaults` in YAML changes the effective grants without code changes.
- `pnpm lint` passes. Existing tests pass without modification (defaults match current values).

### Phase 2: Plan-Tiered Capability Resolution

**Effort:** ~1.5 days
**Risk:** Medium (changes the capability grant resolution path)
**Depends on:** Phase 1
**Implements:** I1 (injection into AGENT_RUNTIME_CONFIG_JSON), D4 (maxInvocations enforcement), D5 (startup observability log)

**Files modified:**
- `packages/domain/src/config/schema.ts` — Validate plan capability entries don't exceed operator ceilings (superRefine).
- `apps/worker/src/agents/capability-policy.ts` — New `resolveEffectiveGrants(operatorDefaults, planCapabilities?, agentToolPolicy?)` function implementing the 3-layer resolution with ceiling enforcement. Add `maxInvocations` enforcement to `checkAccess` (new session-scoped counter, checked before rate limit).
- `apps/worker/src/agent.ts` — Read `effectiveCapabilityGrants` from parsed `AGENT_RUNTIME_CONFIG_JSON` instead of calling `buildCapabilityGrants(toolPolicy)`. Fall back to current behavior if field is absent (rolling deploy safety). Emit structured `info`-level log line with resolved grants summary at startup (see D5).
- `apps/worker/src/agents/agent-message-broker.ts` — Pass plan tier info into `getCapabilityEngine`.
- `apps/worker/src/index.ts` (or `runtime-lifecycle.ts` / `docker-agent-manager.ts`) — Resolve user → plan tier at container launch. Call `resolveEffectiveGrants()` and `resolveEffectiveSandbox()`. Inject results as `effectiveCapabilityGrants` and `effectiveSandboxLimits` fields in `AGENT_RUNTIME_CONFIG_JSON` (see I1).

**New function signature:**
```typescript
function resolveEffectiveGrants(
  operatorDefaults: CapabilityDefaultsConfig,
  planCapabilities: PlanCapabilityEntitlements | undefined,
  agentToolPolicy: Record<string, unknown> | undefined,
): CapabilityGrant[]
```

**Acceptance criteria:**
- Free-tier agent gets `execute_code` at 5/min. Pro-tier agent gets 20/min.
- Per-agent `toolPolicy` override of `maxPerMinute: 100` is clamped to the plan tier ceiling.
- `maxInvocations` is enforced: free-tier agent hitting `maxInvocations: 50` for `execute_code` gets `invocation_limit_exceeded` after 50 calls regardless of rate.
- Agent startup emits a structured log line listing plan tier, grant count, overridden capabilities, and disabled capabilities.
- Agent with no plan tier (absent `effectiveCapabilityGrants` in config) falls back to `buildCapabilityGrants(toolPolicy)` (backward compatible with old workers during rolling deploy).
- `pnpm lint` passes.

### Phase 3: Plan-Tiered Sandbox Limits

**Effort:** ~0.5 day
**Risk:** Low (extends existing pattern from `resourceProfiles`)
**Depends on:** Phase 2

**Files modified:**
- `apps/worker/src/agents/sandbox-enforcer.ts` — Constructor accepts resolved sandbox limits (already does this; just ensure the resolution chain feeds plan-tier values).
- `apps/worker/src/agent.ts` — Build `SandboxEnforcer` with plan-resolved sandbox limits instead of raw `sandboxDefaults`.
- `config/default.yaml` — Add `sandbox` section under each plan's entitlements.

**Acceptance criteria:**
- Free-tier agent gets `maxRequestsPerMinute: 30`. Pro-tier gets `60`.
- Sandbox limits are capped at `sandboxDefaults` (operator ceiling).
- `pnpm lint` passes.

### Phase 4: Tool Argument Limits

**Effort:** ~1 day
**Risk:** Low (additive enforcement in existing tool code)
**Depends on:** Phase 2

**Files modified:**
- `packages/domain/src/tools.ts` — Extend `ToolContext` with `argumentLimits?: Record<string, ArgumentLimits>`.
- `apps/worker/src/tools/code.ts` — Read `ctx.argumentLimits?.execute_code` and enforce `maxCodeBytes` (reject if `Buffer.byteLength(code) > limit`) and `maxDependencies` (reject if `dependencies.length > limit`).
- `apps/worker/src/tools/web-access.ts` — Read `ctx.argumentLimits?.search_web` and enforce `maxQueryLength` and `maxResults` ceiling.
- `apps/worker/src/agent.ts` — Populate `argumentLimits` in ToolContext from the resolved plan entitlements.

**Acceptance criteria:**
- Free-tier agent submitting >50 KB code to `execute_code` gets a clear error: `"code size (65536 bytes) exceeds plan limit (51200 bytes)"`.
- Free-tier agent requesting `maxResults: 10` for `search_web` is clamped to plan limit of 5.
- Argument limits are optional — omitted means "no restriction beyond Zod schema."
- `pnpm lint` passes.

### Phase 5: Documentation and Defaults Tuning

**Effort:** ~0.5 day
**Risk:** None
**Depends on:** Phases 1–4

**Files modified:**
- `config/default.yaml` — Inline comments explaining the capability defaults and per-plan overrides.
- `docs/best-practices/configuration.md` — Add section on capability grant resolution order.
- `docs/tech/agents/tool-access-and-sandboxing.md` — Update to reference config-driven grants instead of hardcoded defaults.

**Acceptance criteria:**
- `config/default.yaml` is self-documenting for the new sections.
- Best practices doc covers the 3-layer resolution model.

---

## Zod Schema Sketch

```typescript
// --- Argument Limits (per-capability) ---

export const ExecuteCodeArgumentLimitsSchema = z.object({
  maxCodeBytes: z.number().int().min(1024).optional(),
  maxDependencies: z.number().int().min(0).optional(),
}).default({});

export const SearchWebArgumentLimitsSchema = z.object({
  maxQueryLength: z.number().int().min(1).optional(),
  maxResults: z.number().int().min(1).max(10).optional(),
}).default({});

// --- Single Capability Default (operator ceiling) ---

export const CapabilityDefaultSchema = z.object({
  enabled: z.boolean().default(true),
  tier: z.enum(['brokered', 'direct', 'never']).default('direct'),
  limits: z.object({
    maxPerMinute: z.number().int().min(1).optional(),
    maxConcurrent: z.number().int().min(1).optional(),
    timeoutMs: z.number().int().min(1000).optional(),
    maxResponseBytes: z.number().int().min(1).optional(),
    maxTotalDownloadBytes: z.number().int().min(1).optional(),
  }).default({}),
  argumentLimits: z.record(z.string(), z.number().int().min(0)).default({}),
});

// --- Operator Capability Defaults (agentRuntime.capabilityDefaults) ---

export const CapabilityDefaultsConfigSchema = z.record(
  z.string(),
  CapabilityDefaultSchema,
).default({});

// --- Plan Capability Entitlements ---

export const PlanCapabilityEntitlementSchema = z.object({
  enabled: z.boolean().optional(),
  limits: z.object({
    maxPerMinute: z.number().int().min(1).optional(),
    maxConcurrent: z.number().int().min(1).optional(),
    timeoutMs: z.number().int().min(1000).optional(),
    maxResponseBytes: z.number().int().min(1).optional(),
  }).optional(),
  argumentLimits: z.record(z.string(), z.number().int().min(0)).optional(),
});

export const PlanCapabilityEntitlementsSchema = z.record(
  z.string(),
  PlanCapabilityEntitlementSchema,
).default({});

// --- Plan Sandbox Entitlements ---

export const PlanSandboxEntitlementsSchema = z.object({
  maxRequestsPerMinute: z.number().int().min(1).optional(),
  maxConcurrentConnections: z.number().int().min(1).optional(),
  maxResponseBytes: z.number().int().min(1).optional(),
  maxTotalDownloadBytes: z.number().int().min(1).optional(),
}).default({});

// --- Extend PlanEntitlementsSchema ---

// Add to existing PlanEntitlementsSchema:
//   capabilities: PlanCapabilityEntitlementsSchema.default({}),
//   sandbox: PlanSandboxEntitlementsSchema.default({}),

// --- Extend AgentRuntimeConfigSchema ---

// Add to existing AgentRuntimeConfigSchema:
//   capabilityDefaults: CapabilityDefaultsConfigSchema.default({}),
```

---

## Resolution Logic (Pseudocode)

```typescript
function resolveEffectiveGrants(
  operatorDefaults: Record<string, CapabilityDefault>,
  planCapabilities: Record<string, PlanCapabilityEntitlement> | undefined,
  agentToolPolicy: Record<string, unknown> | undefined,
): CapabilityGrant[] {
  const grants: CapabilityGrant[] = [];

  for (const [capability, operatorDefault] of Object.entries(operatorDefaults)) {
    const planOverride = planCapabilities?.[capability];
    const agentOverride = agentToolPolicy?.[capability] as Partial<CapabilityGrant> | undefined;

    // 'never' tier cannot be overridden
    if (operatorDefault.tier === 'never') {
      grants.push({ capability, tier: 'never', enabled: false });
      continue;
    }

    // Enabled: all layers must agree (any false wins)
    const enabled = operatorDefault.enabled
      && (planOverride?.enabled ?? true)
      && (agentOverride?.enabled ?? true);

    // Numeric limits: min(operator, plan, agent) — most restrictive wins
    const limits: CapabilityLimits = {};
    for (const field of ['maxPerMinute', 'maxConcurrent', 'timeoutMs', 'maxResponseBytes'] as const) {
      const values = [
        operatorDefault.limits?.[field],
        planOverride?.limits?.[field],
        (agentOverride?.limits as Record<string, number> | undefined)?.[field],
      ].filter((v): v is number => v !== undefined);

      if (values.length > 0) {
        limits[field] = Math.min(...values);
      }
    }

    // Argument limits: min(operator, plan, agent) per key
    const argumentLimits: Record<string, number> = {};
    const allKeys = new Set([
      ...Object.keys(operatorDefault.argumentLimits ?? {}),
      ...Object.keys(planOverride?.argumentLimits ?? {}),
      ...Object.keys((agentOverride as Record<string, unknown>)?.argumentLimits ?? {}),
    ]);
    for (const key of allKeys) {
      const values = [
        operatorDefault.argumentLimits?.[key],
        planOverride?.argumentLimits?.[key],
        ((agentOverride as Record<string, unknown>)?.argumentLimits as Record<string, number> | undefined)?.[key],
      ].filter((v): v is number => v !== undefined);

      if (values.length > 0) {
        argumentLimits[key] = Math.min(...values);
      }
    }

    grants.push({
      capability,
      tier: operatorDefault.tier,
      enabled,
      limits,
      argumentLimits,
    });
  }

  return grants;
}
```

---

## Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    config/default.yaml                        │
│                                                              │
│  agentRuntime.capabilityDefaults   ← operator ceilings       │
│  agentRuntime.sandboxDefaults      ← operator sandbox ceiling│
│  agentRuntime.resourceProfiles     ← container resources     │
│  plans.<planId>.entitlements       ← plan-tier grants        │
│    .capabilities.<cap>.limits                                │
│    .capabilities.<cap>.argumentLimits                        │
│    .sandbox                                                  │
└────────────────────────┬─────────────────────────────────────┘
                         │ loadConfig() at startup
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                    Worker Process                             │
│                                                              │
│  On agent launch:                                            │
│    1. user → billing account → plan tier                     │
│    2. resolveEffectiveGrants(operatorDefaults,                │
│         planCapabilities, agent.toolPolicy)                   │
│    3. resolveEffectiveSandbox(sandboxDefaults,                │
│         planSandbox)                                         │
│    4. Inject into AGENT_RUNTIME_CONFIG_JSON                  │
│    5. Resolve resourceProfile (already exists)               │
└────────────────────────┬─────────────────────────────────────┘
                         │ container launch
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                   Agent Container                             │
│                                                              │
│  CapabilityPolicyEngine(effectiveGrants)                     │
│    → checkAccess() enforces rate + concurrency               │
│                                                              │
│  SandboxEnforcer(effectiveSandboxLimits)                     │
│    → checkOutboundRequest() enforces request rate, download  │
│                                                              │
│  ToolContext.argumentLimits                                   │
│    → each tool checks its own argument limits before exec    │
│                                                              │
│  Container cgroups (from resourceProfiles)                   │
│    → memory, CPU, PID limits (already exists)                │
└──────────────────────────────────────────────────────────────┘
```

---

## Migration & Backward Compatibility

### No database migrations required

- `agents.toolPolicy` (JSONB) already exists and continues to work as per-agent overrides.
- Plan tier is resolved from `users → billing_accounts → plan` at agent launch time — this lookup path already exists for entitlement enforcement.
- No new tables or columns needed.

### Backward compatibility

- If `agentRuntime.capabilityDefaults` is absent (old config), fall back to hardcoded `DEFAULT_CAPABILITY_GRANTS` as a code-level default via Zod `.default({})`.
- If `plans.<planId>.entitlements.capabilities` is absent, all capabilities inherit operator defaults (current behavior).
- If `plans.<planId>.entitlements.sandbox` is absent, sandbox uses `sandboxDefaults` (current behavior).
- Existing `agents.toolPolicy` overrides continue to apply but are now capped by the plan tier.

### Breaking change risk

The only potential behavior change: an agent with `toolPolicy` overrides that exceed its plan tier will see limits reduced to the plan ceiling. This is intentional — the current lack of ceiling enforcement is the bug being fixed.

---

## Decisions (Resolved)

### D1. `read_document` capability — own grant

**Decision:** Own grant, not shared with `browse_url`.

`read_document` and `browse_url` have different risk profiles — PDFs can be large and CPU-intensive to parse, while HTML pages are lighter. A separate grant allows independent rate tuning. Initial defaults match `browse_url` (same `maxPerMinute`, `maxResponseBytes`, `timeoutMs`). Add it to `agentRuntime.capabilityDefaults` and plan-tier entitlements alongside the existing capabilities.

### D2. Filesystem tools — no capability policy in v1

**Decision:** Do not add `list_files`, `read_file`, `delete_file` to the capability policy.

These tools operate exclusively within the agent's own workspace directory and cannot escape the container sandbox. The blast radius is bounded by the container filesystem. Adding capability gates would add latency and complexity to the most frequently called tools for negligible safety benefit. Revisit only if cross-agent file access or shared storage is ever introduced.

### D3. `manage_bot` — both plan-gated and skill-gated

**Decision:** Plan tier controls availability; skill resolution controls visibility. Two independent layers.

- **Plan tier** (`plans.<planId>.entitlements.capabilities.manage_bot.enabled`): determines whether the capability is *available*. Free plan: `enabled: false`. Starter/Pro: `enabled: true`.
- **Skill resolution** (existing behavior): determines whether bot management tools are *visible* to the agent. Only agents with a trading skill preset see bot tools in their tool list.

An agent on the starter plan with no trading skills assigned still can't see bot management tools even though the plan allows it. An agent on the free plan with trading skills assigned sees the tools in its schema but gets `capability_disabled` when it tries to call them. The current skill-gating code in `runtime-tool-visibility.ts` stays untouched.

### D4. `maxInvocations` per-session — enforce it in Phase 2

**Decision:** Yes. Implement enforcement in `checkAccess` alongside the existing rate and concurrency checks.

The `CapabilityLimits` type already defines `maxInvocations` but `checkAccess` doesn't enforce it. Adding the check is ~10 lines — a new session-scoped counter alongside the existing usage counter, checked before the rate limit check.

This is the most useful lever for free-tier cost control. Rate limits prevent bursts but don't cap total usage over a long session. A free-tier agent running for 8 hours at 5 `execute_code` calls/minute could make 2,400 calls. A `maxInvocations: 100` cap makes that predictable.

**Tiering approach:** Set `maxInvocations` only for free tier initially. Omit for paid tiers (or set a very high ceiling as a safety net). Example: free `execute_code.maxInvocations: 50`, starter: `200`, pro: omitted.

### D5. Observability — structured log at startup

**Decision:** Yes. A single structured `info`-level log line at agent startup.

Format:
```json
{
  "msg": "Effective capability grants resolved",
  "agentId": "...",
  "planTier": "free",
  "grantCount": 13,
  "overriddenByPlan": ["execute_code", "search_web", "manage_bot"],
  "overriddenByAgent": ["execute_code"],
  "disabledCapabilities": ["manage_bot", "venue_api", "raw_secrets", "database_write", "host_control"]
}
```

Logs which capabilities were overridden at each layer and which ended up disabled. Does not log actual numeric limit values at `info` — that's `debug` level detail. Also serves as an audit trail for incident review ("why did this agent have these limits?").

---

## Implementation Details (Resolved)

### I1. Injecting effective grants into `AGENT_RUNTIME_CONFIG_JSON`

**Context:** The worker already resolves `user → billing account → plan` for entitlement checks (maxAgents, maxBots, liveEnabled) and resolves the plan tier for `resourceProfiles` when launching containers. The missing step is carrying the resolved capability grants and sandbox limits into the JSON payload injected as the `AGENT_RUNTIME_CONFIG_JSON` env var.

**Existing infrastructure (what we build on):**

The entitlements system is fully wired:
- `packages/domain/src/plan-entitlements.ts` — `resolvePlanEntitlements(config, { planId, isAdmin })` resolves plan ID → `PlanEntitlements`. Handles fallback to default plan, admin bypass, and absolute fallback when no plan exists.
- Convenience accessors already exist: `resolvePlanSkillEntitlements()`, `resolvePlanLimitEntitlements()`, `resolvePlanBlueprintEntitlements()`, `resolvePlanAgentEntitlements()`.
- `ABSOLUTE_FALLBACK_ENTITLEMENTS` (line 21) provides fail-closed defaults when no plan config exists at all.

The session manager (`agent-session-manager.ts`) already resolves the user's plan at launch:
```typescript
// line 329 — plan tier is already resolved here
const userPlanIdForEnforcement = this.config.usageBillingRepo
  ? await this.config.usageBillingRepo.getUserPlanId(agent.userId)
  : null;
const resolvedPlanId = userPlanId ?? this.config.plansConfig?.defaultPlanId ?? 'free';
```

This `resolvedPlanId` is used for billing (spend caps, rate cards) but is **not** currently passed to the launcher. The `LauncherLaunchConfig.planTier` field exists but is never populated:
```typescript
// line 550 — planTier is MISSING from this call
await this.runtimeLauncher.launch({
  agentId: session.agentId,
  sessionId: session.id,
  agentConfig,
  runtimeDescriptor,
  toolPolicy: (agent.toolPolicy as Record<string, unknown> | null) ?? {},
  // planTier: resolvedPlanId,  ← needs to be added
});
```

This also means `agentRuntime.resourceProfiles` (free/pro/enterprise container resources) are configured in YAML but the tier is never resolved at launch — the launcher always falls through to `sandboxDefaults`.

**Approach (Phase 2 implementation):**

1. **Extend `PlanEntitlementsSchema`** — add `capabilities: PlanCapabilityEntitlementsSchema.default({})` and `sandbox: PlanSandboxEntitlementsSchema.default({})` as siblings of the existing `skills`, `agents`, `blueprints`, `limits` fields.

2. **Extend `ABSOLUTE_FALLBACK_ENTITLEMENTS`** in `plan-entitlements.ts` — add `capabilities: {}` and `sandbox: {}` (empty = inherit operator defaults, consistent with the fail-closed pattern for other entitlements).

3. **Add a convenience accessor** — `resolvePlanCapabilityEntitlements(config, planId, isAdmin)` following the existing pattern.

4. **Pass `planTier` to the launcher** — in `agent-session-manager.ts` line 550, add `planTier: resolvedPlanId` to the launch config. This also fixes the existing `resourceProfiles` dead path.

5. **Resolve effective grants in the launcher** — in `agent-runtime-launcher.ts`, after `resolveProfile(config.planTier)` for container resources, also resolve plan capability entitlements and call `resolveEffectiveGrants(operatorDefaults, planCapabilities, config.toolPolicy)`. Inject the result as `effectiveCapabilityGrants` in `AGENT_RUNTIME_CONFIG_JSON`.

6. **Container side** — `agent.ts` reads `effectiveCapabilityGrants` from the parsed config and passes it directly to `new CapabilityPolicyEngine(effectiveGrants)` instead of calling `buildCapabilityGrants(toolPolicy)`. Similarly, `effectiveSandboxLimits` feeds `new SandboxEnforcer(effectiveSandboxLimits)` instead of raw `sandboxDefaults`.

**Backward compatibility:** If `effectiveCapabilityGrants` is absent (old worker during rolling deploy), the agent falls back to the current behavior: `buildCapabilityGrants(toolPolicy)` with hardcoded `DEFAULT_CAPABILITY_GRANTS`. Same for sandbox — absent field means use `sandboxDefaults` as today.

**Side-effect fix:** Passing `planTier` to the launcher also fixes the existing `resourceProfiles` dead path — container resource limits (memoryLimitMb, cpuShares, etc.) will start being tier-differentiated as already configured in YAML.

### I2. Hot-reload on plan upgrade — restart-required in v1

**Decision:** v1 requires an agent restart to pick up new plan limits. No hot-reload.

**Rationale:**
- Plan upgrades are rare events (once per user, maybe a few times over their lifetime). Optimizing for instant propagation isn't worth the complexity.
- The agent session lifecycle already handles restarts gracefully — crash recovery, session circuit breakers, and heartbeat monitoring all exist. A stop/start after plan change is operationally clean.
- The alternative (Redis pub/sub notification → agent polls new grants → `capabilityEngine.replaceGrants()`) is technically feasible since `replaceGrants()` already preserves session counters, but introduces a new cross-process notification channel requiring failure handling, ordering guarantees, and testing.

**UX implication:** When a user upgrades their plan, the UI should show a note: "Your running agents will use the new limits after their next restart." Alternatively, the plan-change handler could auto-restart running agents if a seamless experience is desired — that's a product decision, not an engineering constraint.

**v2 path (if ever needed):** Billing webhook handler publishes a `plan_changed` event to `agent:signals:{agentId}` in Redis → agent's wake loop picks it up on the next poll → agent calls a new API endpoint to fetch its effective grants → calls `capabilityEngine.replaceGrants()` and rebuilds `SandboxEnforcer`. This is a separate feature, not something to design for now.

---

## Effort Summary

| Phase | Effort | Risk |
|---|---|---|
| Phase 1: Operator config for capability defaults | ~1 day | Low |
| Phase 2: Plan-tiered capability resolution | ~1.5 days | Medium |
| Phase 3: Plan-tiered sandbox limits | ~0.5 day | Low |
| Phase 4: Tool argument limits | ~1 day | Low |
| Phase 5: Documentation and defaults tuning | ~0.5 day | None |
| **Total** | **~4.5 days** | |

## Key Files

| File | Role |
|---|---|
| `packages/domain/src/config/schema.ts` | Zod schemas for all config layers — extend `PlanEntitlementsSchema`, `AgentRuntimeConfigSchema` |
| `packages/domain/src/plan-entitlements.ts` | Plan resolution logic — extend with `resolvePlanCapabilityEntitlements()`, update `ABSOLUTE_FALLBACK_ENTITLEMENTS` |
| `config/default.yaml` | Operator config with capability defaults and plan definitions |
| `apps/worker/src/agents/capability-policy.ts` | CapabilityPolicyEngine, grant resolution, `DEFAULT_CAPABILITY_GRANTS` → config-driven |
| `apps/worker/src/agents/sandbox-enforcer.ts` | SandboxEnforcer — in-process resource limits |
| `apps/worker/src/agents/agent-session-manager.ts` | Session launch — pass `planTier: resolvedPlanId` to launcher (line 550) |
| `apps/worker/src/agents/agent-runtime-launcher.ts` | Container launcher — resolve effective grants, inject into `AGENT_RUNTIME_CONFIG_JSON` |
| `apps/worker/src/agent.ts` | Agent runtime — read `effectiveCapabilityGrants` from config, build engines |
| `apps/worker/src/agents/agent-message-broker.ts` | Brokered tool capability enforcement |
| `apps/worker/src/tools/code.ts` | execute_code — capability + argument limit enforcement |
| `apps/worker/src/tools/web-access.ts` | search_web, browse_url — capability + argument limit enforcement |
| `packages/domain/src/tools.ts` | ToolContext interface (add argumentLimits) |
| `apps/worker/src/index.ts` | Worker entry — config loading, wires `plansConfig` to session manager |

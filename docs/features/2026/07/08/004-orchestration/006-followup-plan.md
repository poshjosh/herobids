# Follow up plan

This is a followup to docs/features/2026/07/08/004-orchestration/002-implementation-plan.md

### 1. Termination listener double-registration (MEDIUM) — DONE
- Both `DockerRuntimeAdapter` constructor and `AgentRuntimeLauncher` constructor register termination listeners on the same `DockerAgentManager`. Any `onTermination()` subscriber would receive duplicate events per container death.
- **Impact:** None currently — no production code calls `.onTermination()` yet. 
- **Fix:** Remove the duplicate listener registration from the launcher. The adapter already bridges its own events.
- **Files:** `apps/worker/src/agents/agent-runtime-launcher.ts`, `apps/worker/src/agents/docker-runtime-adapter.ts`

### 2. Missing test coverage for sharedServices path in buildAgentEnv (MEDIUM) — PENDING
- `runtime-lifecycle.test.ts` only tests the fallback branch (no `sharedServices`). No test verifies the `sharedServices` → cluster-safe URL path.
- **Fix:** Add 2-3 test cases for `sharedServices` URL construction.

### 3. list_eligible_agent_nodes doesn't exclude control-plane client node (MEDIUM) — PENDING
- `scale-common.sh:list_eligible_agent_nodes()` filters Nomad nodes by eligibility but doesn't exclude the Nomad server's own client node (the server runs a client on the control-plane host per `cloud-init.yaml`). If that node ever appears idle, the scale-in routine could theoretically drain the control-plane host.
- **Impact:** Low in practice — the server node carries system allocations and `min_agent_nodes` only tracks the agent pool count. Still worth hardening before production rollout.
- **Fix:** Add a node-name prefix filter (`herobids-agent-*`) or Nomad meta-attribute filter so the control-plane client is never a scale-in candidate.
- **File:** `infra/hetzner/scripts/scale-common.sh`

### 4. `||` operator in resource fallback treats `0` as falsy (LOW) — PENDING
- `this.defaultResources.memoryLimitMb || 512` silently falls back to hardcoded default if operator configures a resource to `0`. For `maxWallClockMs`, `0` means "unlimited" but `0 || undefined` loses that semantic.
- **Impact:** None currently — no operator config uses `0` for the main resources, and `maxWallClockMs` is not consumed by any adapter yet.
- **Fix:** Use `??` consistently: `this.defaultResources.memoryLimitMb ?? 512`.
- **File:** `apps/worker/src/agents/agent-runtime-launcher.ts`

### 5. Competing tfvars templates (LOW) — PENDING
- Three tfvars templates exist: `terraform.tfvars.example`, `staging.tfvars.example`, `production.tfvars.example`. May confuse new operators.
- **Fix:** Add note directing to per-environment templates, or deprecate legacy template.

---

## Outstanding Issues

### [Item 1: Termination listener double-registration]
- 🟡 MEDIUM — Stale docstring on `DockerRuntimeAdapter.notifyTermination()` in `apps/worker/src/agents/docker-runtime-agent.ts`. The JSDoc says "Called by AgentRuntimeLauncher" but the launcher no longer calls it after this fix. Should be updated to reflect it's called by the adapter's own constructor-registered listener.
- 🟡 MEDIUM — No test coverage for termination event bridging. Once termination handlers are added (e.g., crash reconciliation), they could receive duplicate events without tests verifying single-firing. Add a test in `runtime-lifecycle.test.ts`.
- 🔵 LOW — Comment in `agent-runtime-launcher.ts` could be more explicit about *why* the code was removed (prevent double-notification of onTermination subscribers).

### [Item 2: Missing test coverage for sharedServices path]
- 🟡 MEDIUM — Pre-existing bug: `DATABASE_URL` password is not URL-encoded in `buildAgentEnv`. Passwords with `@`, `:`, `/`, `%` would produce malformed URLs. Should add `encodeURIComponent` to postgresPassword interpolation. Tests use `s3cr3t` (no special chars) so bug goes undetected. File follow-up bug report.
- 🔵 LOW — Test 3 uses realistic `redis://localhost:6379` as ignored value; should use self-documenting placeholder like `redis://should-be-ignored:6379` for consistency.
- 🔵 LOW — Test password `s3cr3t` could trigger secret-scanning false positives; use obviously fake password like `test-pg-pass`.
# Phase 3 Block 1 — Step 11: generic client migration + internal transport seam (T1.1, T1.2, T1.3) — plan

**Status:** plan only, not implemented. **Repo/branch:** herobids `phase3-external-backend` (HEAD at planning `8d30dd46`). No traderton edits.
**Lands after:** T0.3 (signing vectors), T0.4 (descriptor fixtures), T0.5, T0.6 (CF-1 idempotency). Plans: `block0-fixtures-plan.md`, `t0.6-idempotency-plan.md`.
**Normative:** Step 10 plan §1, §2, §2.4, §2.5, §5, §7 (Step 11 tasks 1–5); Phase-3 `ENTRYPOINT/TASKS/INVARIANTS/SEAM`; AGENTS.md; `docs/best-practices/configuration.md`.
**Behaviour:** none intended. Rename + config reshape + a one-implementation seam. T0.6's IV-1 is already in and verified.

---

## 0. Ground facts (verified at `8d30dd46`; re-verify after Block 0 lands)

| Fact | Evidence / consequence |
|---|---|
| Module = `packages/domain/src/traderton/{client,contract,sign,index}.ts` + `client.test.ts`, `sign.test.ts`; subpath `"./traderton"` → `dist/traderton/*` in `packages/domain/package.json:20-23` | Block 0 adds `signing-vectors.test.ts`, `client-signing-vectors.test.ts`, `descriptor-conformance.test.ts`, `__fixtures__/{invocation-signing-vectors.json,descriptor-conformance/}`, `request-id.ts(+test)` in the same dir — all move with `git mv` |
| `sign.test.ts` imports only `./sign.js` (`buildCanonicalString, signRequest, signInvoke, signStatus, SigningIdentity`) + `vitest` + `node:crypto`; no `TRADERTON_*` constant; uses literal paths | **No conflict** with "unmodified": none of its symbols is in the rename table. Same for `signing-vectors.test.ts` (imports `./sign.js` + fixture via `import.meta.url`, per T0.3 plan) |
| Wire header names `x-traderton-{consumer-id,key-id,timestamp,signature}` + `x-request-deadline-at` (`sign.ts:76-83`) | **FROZEN wire bytes (Step 10 §5). Never renamed.** `sign.ts` stays byte-identical |
| **Vitest alias bug (verified with Vite's resolver):** root `vitest.config.ts` aliases `'@herobids/domain'` → `src/index.ts`; Vite prefix-matches, so `@herobids/domain/traderton` resolves to the non-existent `packages/domain/src/index.ts/traderton` | Works today only because every test import of the subpath is `import type` (erased). Any **value** import from a test breaks. The T0.6/T0.3 plans' claim "vitest resolves the subpath via exports→dist" is false under the root config (true only for `pnpm --filter … exec vitest`, which loads no config). T0.6's contract test value-imports the client factory → expect T0.6 to have added a `/traderton` alias; C1 renames or adds it |
| `pnpm test` (and `run-all-tests.sh` step 1) = root `vitest run` with the root config | Use the root form `pnpm exec vitest run <paths>` as the authoritative test mode |
| `pnpm lint` = `tsc --noEmit` on `files: []` → type-checks nothing; `*.test.ts` excluded from every tsconfig | `pnpm build` (`build-docs-index` + `pnpm -r run build`) is the type gate; I7 grep covers tests |
| Construction sites (6/3 files): `apps/worker/src/index.ts:440,468,502,794`; `apps/worker/src/agent.ts:938`; `apps/api/src/index.ts:198` | Line numbers shift after T0.6 (W4/W5). Re-locate with `rg -n "createTradertonClient\(" apps` |
| Two more config consumers: worker `index.ts:286,340` `boundaryConfigJson: JSON.stringify(appConfig.boundary)` → agent env `BOUNDARY_CONFIG_JSON` (`runtime-lifecycle.ts:41,170`, `docker-agent-manager.ts:74,152,198,295`) parsed by `agent.ts:122,912` with `BoundaryConfigSchema` | The per-agent payload **carries the HMAC secret** (container has no `TRADERTON_*` env). Must carry a resolved record after the reshape |
| `appConfig.boundary.requestTimeoutMs` read at api `index.ts:203,218,277,289,302,308-311,318,320,345,363`, worker `index.ts:813` | Passed positionally to ~14 route registrations alongside a possibly-undefined client |
| Env: `TRADERTON_BOUNDARY_{URL,HMAC_SECRET,CONSUMER_ID,KEY_ID,TIMEOUT_MS}` in both `ENV_OVERRIDES` (`apps/api/src/config.ts:71-75`, `apps/worker/src/config.ts:83-87`); set by `.env` (compose `env_file`), `docker/xstack.override.yml:36,42` (URL), `scripts/shell/run/with-boundary.sh`, staging `infra/hetzner/.env.environment.example:86-89` | Twins carrying these keys: `.env.example:181-185`, `infra/hetzner/.env.environment.example:86-89`. `.env.ops.dev.example`, `.env.ops.environment.example`, `infra/hetzner/.env.backend.example`: none |
| `apps/worker/src/env-example-drift.test.ts`: `.env.example` ⊇ ENV_OVERRIDES keys ∪ `process.env['X']` literals; **no stale entries**; every ENV_OVERRIDES path's segments appear as `key:` lines in `default.yaml`; `BOUNDARY_CONFIG_JSON` in `IGNORED_ENV_VARS` | If `TRADERTON_BOUNDARY_HMAC_SECRET` stops being an ENV_OVERRIDES key, the stale check fails → the test must learn about secret refs. Array indices in override paths would fail the segment check |
| Loader `deepMerge` replaces arrays, merges objects; `setNestedValue` walks dotted keys | A YAML **array** registry cannot be addressed by env overrides or per-env overlays |
| `'traderton'`/`"traderton"` literals in non-test TS under `apps/ packages/`: **0** | Keep it 0 (I1 spirit) |
| No health gating exists in the client today | `health.readyPath` is carried in the definition, unread in Block 1 (gap, §9 R8) |
| api has its OWN `TradertonReadBoundary` / `createTradertonReadBoundary` in `apps/api/src/routes/exports-traderton.ts:89,125` (CF-11), used by `exports.ts`, `capabilities/trading.ts`, `traderton-operator-defaults.ts` | Worker-adapter renames must be scoped to `apps/worker/` |
| Dockerfiles / compose / tsconfigs reference no `traderton` module path | No Docker change. `scripts/ts/build-docs-index.ts` unrelated |

**Preflight (before C1):** G3 (`env | grep TRADERTON_` empty; `rg -n TRADERTON_BOUNDARY_URL .env` no match; `BOUNDARY_BASE_URL` unset). Confirm Block 0 landed: `ls packages/domain/src/traderton/{signing-vectors.test.ts,client-signing-vectors.test.ts,request-id.ts,__fixtures__}` and `ls apps/worker/src/traderton/write-idempotency.contract.test.ts`. Record `T1_BASE=$(git rev-parse HEAD)`. Re-run the inventory commands in C1/C5 rather than trusting the lists below.

---

## 1. Commit sequence (each commit: build + lint + domain/api/worker vitest green)

| # | Task | Commit message | Why separate |
|---|---|---|---|
| C1 | T1.1 | `refactor(domain): rename traderton client module to external-backend (Phase 3 T1.1)` | Pure rename + mechanical importer rewrite. Frozen files R100 |
| C2 | T1.1 | `feat(domain): ExternalBackendDefinition schema and registry helpers (Phase 3 T1.1)` | Additive, unwired, fully unit-tested |
| C3 | T1.2 | `refactor(domain): internal transport seam with RestTransport (Phase 3 T1.2)` | One-implementation seam; REST bytes pinned by T0.3 |
| C4 | T1.3 | `refactor(config): external backend registry replaces the boundary block (Phase 3 T1.3)` | Config swap + the 6 registry lookups + agent payload, together |
| C5 | T1.3 | `refactor: generic external-backend ctx ports and worker adapters (Phase 3 T1.3)` | Port/type/adapter renames |

**Why the registry wiring lands in C4, not T1.1 (P3-n15):** removing `appConfig.boundary` breaks all 6 sites at compile time, and keeping both blocks is a D6 dual-config shim whose env overrides can target only one of them (the local stack would silently lose its URL/creds). So T1.1 = rename (C1, kept green by rewriting every importer in the same commit) + the definition/schema/helpers (C2, unwired). T1.3 adds what makes it live: `appConfig.externalBackends` + registry lookups at the 6 sites (C4) and the ctx-port rename (C5). Record in TASKS that T1.1's "add the `appConfig.externalBackends[]` registry" exit item is met at C4.

---

## 2. T1.1

### C1 — rename (mechanical)

1. `git mv packages/domain/src/traderton packages/domain/src/external-backend` (moves Block 0 tests + `__fixtures__/` too).
2. `packages/domain/package.json` exports: `"./traderton"` → `"./external-backend": { "import": "./dist/external-backend/index.js", "types": "./dist/external-backend/index.d.ts" }`.
3. `vitest.config.ts`: add `'@herobids/domain/external-backend': new URL('./packages/domain/src/external-backend/index.ts', import.meta.url).pathname` **before** the `'@herobids/domain'` entry (or rename T0.6's `/traderton` alias if present). P3-n14.
4. Symbol table (apply to every file found by the inventory; `perl -pi -e` with `\b`, never BSD `sed`):

| contract.ts | → |
|---|---|
| `TradertonActorType` | `ExternalBackendActorType` |
| `TradertonCaller` | `ExternalBackendCaller` |
| `TradertonSubject` | `ExternalBackendSubject` |
| `TradertonToolInvocationV1` | `ExternalBackendToolInvocationV1` |
| `TradertonBoundaryFailureCode` | **`ExternalBackendFailureCode`** (P3-n2) |
| `TradertonSuccessOutcome` / `TradertonFailureOutcome` / `TradertonOutcome` | `ExternalBackendSuccessOutcome` / `ExternalBackendFailureOutcome` / `ExternalBackendOutcome` |
| `TradertonToolResultV1` | `ExternalBackendToolResultV1` |
| `TradertonToolInvocationStatusV1` | `ExternalBackendToolInvocationStatusV1` |
| `TRADERTON_INVOKE_PATH` / `TRADERTON_STATUS_PATH_PREFIX` | `EXTERNAL_BACKEND_INVOKE_PATH` / `EXTERNAL_BACKEND_STATUS_PATH_PREFIX` (values unchanged) |
| `tradertonStatusPath()` | `externalBackendStatusPath()` |

| client.ts | → |
|---|---|
| `TradertonClientConfig` | `ExternalBackendClientConfig` |
| `TradertonClientResult` | `ExternalBackendClientResult` |
| `TradertonClient` (class) | `ExternalBackendClient` |
| `createTradertonClient()` | `createExternalBackendClient()` |
| `InvokeToolInput`, `PollOptions` | **kept** (already generic; not in §2 table) |

| sign.ts / request-id.ts (T0.6) | kept unchanged: `SigningIdentity`, `SignRequestInput`, `SignedHeaders`, `buildCanonicalString`, `signRequest`, `signInvoke`, `signStatus`, `deriveRequestId`, `INVOCATION_REQUEST_ID_NAMESPACE` |
|---|---|

   Regex: `s#\@herobids/domain/traderton\b#\@herobids/domain/external-backend#g` + one `s/\bOLD\b/NEW/g` per row. `\b` keeps `TradertonClient` from matching inside `TradertonClientResult`/`createTradertonClient`/`stubTradertonClient`. Comments/test-name strings containing these tokens are renamed too (intended). Prose word "Traderton" elsewhere is not touched.
5. Explicit edits the regex doesn't cover: `packages/domain/src/trading/tool-contract.ts:186` `import('../traderton/client.js').TradertonClientResult` → `import('../external-backend/client.js').ExternalBackendClientResult`; header comments of `external-backend/{index,client,contract}.ts` (generic wording; "Transport + envelope + mapping ONLY" stays); `client.ts:31` doc "subset of the domain BoundaryConfig" → "built from an ExternalBackendDefinition + resolved secret"; `packages/domain/src/index.ts:52-57` comment → `@herobids/domain/external-backend`.
6. Scripts (not type-checked → verify by running): `scripts/ts/generate-signing-vectors.ts` (T0.3) import `../../packages/domain/src/traderton/index.js` → `external-backend`, symbols per table, output path → `external-backend/__fixtures__/`. `scripts/ts/generate-descriptor-conformance-fixtures.ts` (T0.4) output dir → `external-backend/__fixtures__/descriptor-conformance/` (do **not** run it; it is non-deterministic).
7. Docs (operational, not historical): `.github/skills/external-backend-genericization/SKILL.md:32,96`, `.github/skills/trading-boundary-ops/SKILL.md:60,109,188` → new paths/names. Phase-3 `SEAM.md` §3.1/§3.2: replace the "pre-T1.1 lives at `traderton/__fixtures__/`" note with "moved at T1.1 (`<C1 sha>`), bytes unchanged". **Leave historical docs** (`docs/features/2026/09/**`, `docs/tech/trading/audits/**`, `docs/features/pending/**`, `infra/hetzner/docs/runbooks/phase1-operational-readiness.md`).
8. **Do not touch:** `sign.ts`, `sign.test.ts`, `signing-vectors.test.ts`, `__fixtures__/**` (none matches the regex; exclude them from the perl file list anyway).

**Importer inventory** (`rg -l -g '!dist' "@herobids/domain/traderton|<symbol regex>" apps packages scripts`; 58 subpath importers + 5 symbol-only at `8d30dd46`):

| Group | Files |
|---|---|
| domain (in-module) | `external-backend/{client,contract,index}.ts`, `client.test.ts`, `client-signing-vectors.test.ts` (T0.3; imports renamed, assertions unchanged), `request-id(.test).ts` (T0.6; expected untouched), `descriptor-conformance.test.ts` (T0.4; expected untouched) |
| domain (outside module) | `trading/tool-contract.ts` (relative type import), `src/index.ts` (comment) |
| api prod (24) | `agents/trading-profile-reconciliation-saga.ts`, `index.ts`, `plan-guards.ts`, `provider-links.ts`, `routes/{actor-health,agent-interactivity,agents,analytics,blueprints,bots,capabilities/index,capabilities/trading,chat,connections,dashboard,exports-traderton,exports,reconciliation,setup,telegram-command-handlers,views}.ts`, `services/{agent-blueprint-sync-service,agent-lifecycle-service,blueprint-performance-scorer}.ts`; comment-only: `config.ts:67` |
| api tests (19) | `__tests__/functional/helpers.ts` (`InvokeToolInput`, `TradertonBoundaryFailureCode`), `agents/trading-profile-reconciliation-saga.test.ts`, `plan-guards.test.ts`, `routes/{actor-health,agents,analytics,blueprints,bots,capabilities/trading-presentation,capabilities/trading,connections,dashboard,exports-traderton,exports,reconciliation,setup,telegram-command-handlers,views}.test.ts`, `services/blueprint-performance-scorer.test.ts`; comment-only: `routes/blueprints.integration.test.ts:262` |
| worker prod (9) | `agent-evaluation/{evaluation-runtime,run-evaluation}.ts`, `agent.ts`, `agents/{agent-message-broker,decision-boundary-mapping}.ts`, `index.ts`, `tools/traderton-read.ts`, `traderton/{read-adapter,write-adapter}.ts` |
| worker tests (4 + T0.6) | `agents/{agent-broker,agent-decision-handler}.test.ts`, `services/approval-service.test.ts`, `traderton/read-adapter.test.ts`; T0.6: `traderton/{write-adapter.test.ts,write-idempotency.contract.test.ts,__tests__/fake-idempotent-boundary.ts}` |
| scripts | `ts/generate-signing-vectors.ts` (T0.3), `ts/generate-descriptor-conformance-fixtures.ts` (T0.4, path only) |
| config/infra | `packages/domain/package.json`, `vitest.config.ts`. No Dockerfile/compose/tsconfig hits |

**C1 verification**
```sh
pnpm --filter @herobids/domain run clean && pnpm build        # stale dist/traderton must not mask a missed importer
pnpm lint
pnpm exec vitest run packages/domain/src/external-backend
pnpm --filter @herobids/domain exec vitest run src/external-backend/sign.test.ts   # I4 form
pnpm --filter @herobids/domain exec vitest run -t "signing vectors"
pnpm --filter @herobids/scripts run generate-signing-vectors -- --check            # generator repointed + bytes unchanged
pnpm exec vitest run apps/api apps/worker
# frozen-bytes proof: blob ids identical across the rename
for f in sign.ts sign.test.ts signing-vectors.test.ts __fixtures__/invocation-signing-vectors.json; do
  [ "$(git rev-parse "HEAD~1:packages/domain/src/traderton/$f")" = "$(git rev-parse "HEAD:packages/domain/src/external-backend/$f")" ] && echo "R100 $f"; done
git diff --name-status -M HEAD~1 HEAD -- packages/domain/src | rg "sign|__fixtures__"   # expect R100 rows
# completeness (expect no output)
rg -n "@herobids/domain/traderton|domain/src/traderton|\.\./traderton/client" apps packages scripts vitest.config.ts .github -g '!dist'
rg -nw -g '!dist' "TradertonClient|TradertonClientResult|TradertonClientConfig|createTradertonClient|TradertonSubject|TradertonCaller|TradertonActorType|TradertonToolInvocationV1|TradertonBoundaryFailureCode|TradertonOutcome|TradertonSuccessOutcome|TradertonFailureOutcome|TradertonToolResultV1|TradertonToolInvocationStatusV1|TRADERTON_INVOKE_PATH|TRADERTON_STATUS_PATH_PREFIX|tradertonStatusPath" apps packages scripts
shasum -a 256 packages/domain/src/external-backend/__fixtures__/invocation-signing-vectors.json   # == SEAM.md §3.1
```

### C2 — `ExternalBackendDefinition` + Zod + pure helpers (unwired)

**Location (P3-n4):** `packages/domain/src/config/external-backends.ts` (+ `external-backends.test.ts`), exported via `config/index.ts` → main barrel. Pure Zod, no node imports, so `AppConfigSchema` (main barrel, reaches `apps/web`) can use it without pulling the node-only subpath. Dependency direction: `external-backend/` → `config/` only; `config/` never imports `external-backend/`.

```ts
export const EXTERNAL_BACKEND_PROTOCOLS = ['rest', 'mcp'] as const;          // DT2 protocol SET
export type ExternalBackendProtocol = (typeof EXTERNAL_BACKEND_PROTOCOLS)[number];
export const DEFAULT_EXTERNAL_BACKEND_PROTOCOL: ExternalBackendProtocol = 'rest';
export const DEFAULT_EXTERNAL_BACKEND_REQUEST_TIMEOUT_MS = 10_000;           // today's BoundaryConfigSchema default
/** D19: environments where protocol 'mcp' may be configured. */
export const MCP_ALLOWED_ENVIRONMENTS = ['development', 'test'] as const;

export const ExternalBackendProtocolSchema = z.enum(EXTERNAL_BACKEND_PROTOCOLS);
const BackendIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const EnvVarNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);             // a NAME, never a secret
const ToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const SkillRefSchema = z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/); // D11 owner/repo/skill

const ExternalBackendEntryObject = z.object({
  enabled: z.boolean().default(true),
  endpoint: z.object({
    baseUrl: z.string().url(),
    contractVersion: z.literal('1.0').default('1.0'),
    protocol: ExternalBackendProtocolSchema.default(DEFAULT_EXTERNAL_BACKEND_PROTOCOL),
    toolProtocolOverrides: z.record(ToolNameSchema, ExternalBackendProtocolSchema).optional(),
    mcpPath: z.string().regex(/^\/[^?#]*$/).optional(),
    requestTimeoutMs: z.number().int().min(1_000).default(DEFAULT_EXTERNAL_BACKEND_REQUEST_TIMEOUT_MS), // P3-n6
  }),
  caller: z.object({ consumerId: z.string().min(1), keyId: z.string().min(1), hmacSecretRef: EnvVarNameSchema }),
  health: z.object({ readyPath: z.string().regex(/^\//).default('/health/ready') }).default({}),
  trustedDescriptorSigningKeys: z.array(z.object({
    keyId: z.string().min(1),
    publicKey: z.string().startsWith('-----BEGIN PUBLIC KEY-----'),       // PEM SPKI (T0.4 P3)
    status: z.enum(['active', 'retiring']),
  })).default([]),
  approvedSourceSkillRefs: z.array(SkillRefSchema).default([]),
  descriptorPinning: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('pinned'), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
    z.object({ mode: z.literal('maxAge'), seconds: z.number().int().positive() }),
  ]),
});
/** mcpPath required when endpoint.protocol or any override === 'mcp'; signing keyIds unique; skill refs unique. */
function refineExternalBackendEntry(entry: z.infer<typeof ExternalBackendEntryObject>, ctx: z.RefinementCtx): void;

const ExternalBackendEntrySchema = ExternalBackendEntryObject.superRefine(refineExternalBackendEntry);
export const ExternalBackendDefinitionSchema = ExternalBackendEntryObject
  .extend({ backendId: BackendIdSchema })
  .superRefine(refineExternalBackendEntry);
export type ExternalBackendDefinition = z.infer<typeof ExternalBackendDefinitionSchema>;
// T0.4 projection test uses ExternalBackendEntryObject.pick({ enabled, trustedDescriptorSigningKeys, approvedSourceSkillRefs, descriptorPinning }) + backendId

/** YAML shape: map keyed by backendId (P3-n5); parsed shape: ExternalBackendDefinition[] (Step 10 §1). */
export const ExternalBackendRegistrySchema = z.record(BackendIdSchema, ExternalBackendEntrySchema)
  .default({})
  .transform((entries) => Object.entries(entries).map(([backendId, entry]) => ({ backendId, ...entry })));

/** Worker → agent container payload (replaces BOUNDARY_CONFIG_JSON's BoundaryConfig). */
export const ResolvedExternalBackendSchema = z.object({ definition: ExternalBackendDefinitionSchema, hmacSecret: z.string().min(1) });
export type ResolvedExternalBackend = z.infer<typeof ResolvedExternalBackendSchema>;

export function findExternalBackend(registry: readonly ExternalBackendDefinition[], backendId: string | undefined): ExternalBackendDefinition | undefined;
/** Pure: env is injected (only the app config loaders pass process.env). */
export function resolveExternalBackend(
  registry: readonly ExternalBackendDefinition[], backendId: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Result<ResolvedExternalBackend>;   // err codes: external_backend.not_selected | .not_registered | .disabled | .secret_missing ('' counts as missing)
/** D19: messages for every 'mcp' use (protocol or override) when environment ∉ MCP_ALLOWED_ENVIRONMENTS. */
export function findExternalBackendProtocolViolations(registry: readonly ExternalBackendDefinition[], environment: string): string[];
```

Also in the subpath: `packages/domain/src/external-backend/client-config.ts` — `export function buildExternalBackendClientConfig(definition: ExternalBackendDefinition, hmacSecret: string): ExternalBackendClientConfig` mapping `endpoint.baseUrl, caller.consumerId, caller.keyId, hmacSecret, endpoint.requestTimeoutMs` (C3 adds the protocol fields); `index.ts` gains `export * from './client-config.js';`. `ExternalBackendClientConfig` keeps today's flat fields so client tests' configs stay valid.

Doc-first (SEAM §4): in the same commit, amend Step 10 plan §1 "Config migration" (map-keyed YAML → array; `endpoint.requestTimeoutMs` added; `idempotencyRetentionHours` dropped; `hmacSecretRef` = env var name; `tradingBackendId` binding) and §2 table (explicit rows incl. `ExternalBackendFailureCode` and the kept names). No cross-repo bytes change → no fixture change.

**C2 tests** (`config/external-backends.test.ts`, `external-backend/client-config.test.ts`):
- `applies defaults: enabled, contractVersion 1.0, protocol rest, health.readyPath, empty trust lists`
- `rejects an unknown protocol` / `rejects an unknown protocol in toolProtocolOverrides`
- `requires mcpPath when the protocol or any tool override is mcp`
- `rejects an hmacSecretRef that is not an environment variable name`
- `rejects duplicate descriptor signing keyIds` / `rejects a malformed approved skill ref`
- `pinned descriptorPinning requires a 64-hex sha256`
- `parses a registry map into definitions carrying their backendId` / `rejects an invalid backendId key`
- `accepts the T0.4 conformance manifest baseDefinition and every variant override as trust fields` (reads `../external-backend/__fixtures__/descriptor-conformance/manifest.json`; schema↔fixture agreement for T3.1)
- `resolveExternalBackend returns the definition and the secret read from the referenced env var`; `… reports not_selected / not_registered / disabled / secret_missing` (empty string included)
- `flags mcp in staging and production, allows it in development and test, never flags rest`
- `buildExternalBackendClientConfig maps endpoint and caller fields onto the client config`

```sh
pnpm exec vitest run packages/domain/src/config/external-backends.test.ts packages/domain/src/external-backend
pnpm build && pnpm lint
```

---

## 3. T1.2 — internal transport seam (C3)

### Files (all INTERNAL; nothing added to `index.ts` or `package.json` — I3)

`packages/domain/src/external-backend/transports/transport.ts`
```ts
import type { ExternalBackendToolInvocationV1, ExternalBackendToolResultV1 } from '../contract.js';

/**
 * One invocation exactly as built by ExternalBackendClient.buildEnvelope.
 * I5: requestId and idempotencyKey are REQUIRED first-class inputs. A transport carries them on the
 * wire (REST: body; MCP: params._meta) and never mints, defaults, rewrites, re-orders or drops them.
 */
export type TransportInvocation = Readonly<ExternalBackendToolInvocationV1> & {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly deadlineAt: string;
};
/** Per-attempt options, computed ABOVE the seam (no deadline arithmetic below it). */
export interface TransportAttempt { readonly timeoutMs: number }
export interface TransportStatusAttempt extends TransportAttempt { readonly deadlineAt: string }
/** Wire-decoded, transport-neutral outcome of ONE request. Mapping to ExternalBackendClientResult stays in the client. */
export type TransportOutcome =
  | { kind: 'terminal'; result: ExternalBackendToolResultV1 }
  | { kind: 'in_progress'; requestId: string; correlationId: string }
  | { kind: 'transport_error'; message: string };

export interface ExternalBackendTransport {
  invoke(invocation: TransportInvocation, attempt: TransportAttempt): Promise<TransportOutcome>;
  /**
   * Optional capability: NON-executing status lookup by requestId alone (REST GET status).
   * Transports without one (MCP, D15) omit it; the client then resolves in_progress by a
   * same-key re-issue. Always call as `transport.lookupStatus(...)` (never detach — `this`).
   */
  lookupStatus?(requestId: string, attempt: TransportStatusAttempt): Promise<TransportOutcome>;
}
```

`transports/rest-transport.ts` — `export class RestTransport implements ExternalBackendTransport`, ctor `{ baseUrl: string; identity: SigningIdentity }` (trailing-slash trim stays in the client and is passed in trimmed).
- `invoke`: `const { headers, rawBody } = signInvoke(this.identity, EXTERNAL_BACKEND_INVOKE_PATH, invocation);` — **the identical call** to today's `client.ts:189` (same object reference → same `JSON.stringify` key order → frozen bytes; T0.3 `client-signing-vectors.test.ts` pins it). `fetch(baseUrl + path, { method: 'POST', headers, body: rawBody, signal: AbortSignal.timeout(attempt.timeoutMs) })`. Decoding moved verbatim from `parseInvokeResponse`/`isStatusShape`: throw → `transport_error 'request to boundary failed'`; `!ok` → ``boundary returned status ${status}``; JSON fail → `'boundary returned an unreadable response'`; status `in_progress` → `in_progress`; status `terminal` → `terminal(body.result)`; else `terminal(body)`.
- `lookupStatus`: `const path = externalBackendStatusPath(requestId); signStatus(this.identity, path, { deadlineAt: attempt.deadlineAt })` — identical to today's `poll`; GET with `AbortSignal.timeout(attempt.timeoutMs)`; `'status request to boundary failed'` / status / `'boundary returned an unreadable status response'`; T0.6's non-status body (e.g. `not_found.resource`) → `terminal(body)`; `terminal` → `terminal(result)`; `in_progress` → `in_progress`.
- Messages kept byte-identical (they surface to callers/logs).

`transports/select-transport.ts` — **the single composition point** (only file that names a transport class; I2's filter exempts `transports/`):
```ts
export interface TransportSelectorOptions {
  baseUrl: string; identity: SigningIdentity;
  protocol: ExternalBackendProtocol;
  toolProtocolOverrides?: Readonly<Record<string, ExternalBackendProtocol>>;
  mcpPath?: string;
}
export type TransportForTool = (toolName: string | undefined) => ExternalBackendTransport;
export function createTransportSelector(options: TransportSelectorOptions): TransportForTool;
// factories: { rest: () => new RestTransport({ baseUrl, identity }) }   — T2.3 adds `mcp: () => new McpTransport({ baseUrl, mcpPath, identity })`
// Instantiates every protocol the config uses (protocol ∪ override values) once, up front.
// A used protocol with no factory → throw Error('external_backend.protocol_unavailable: …') at construction
// = fatal misconfiguration at startup (P3-n10). toolName undefined → `protocol`.
```

### `client.ts` changes (orchestration stays here; never names a transport class, not even in comments — I2)
- ctor: `this.selectTransport = createTransportSelector({ baseUrl, identity, protocol: config.protocol ?? DEFAULT_EXTERNAL_BACKEND_PROTOCOL, toolProtocolOverrides: config.toolProtocolOverrides, mcpPath: config.mcpPath })`. Private field → not emitted with a type in `client.d.ts` (I3b).
- `ExternalBackendClientConfig` += `protocol?: ExternalBackendProtocol; toolProtocolOverrides?: Readonly<Record<string, ExternalBackendProtocol>>; mcpPath?: string` (optional; one shared default constant, so existing test configs stay valid). `buildExternalBackendClientConfig` always sets them from the definition.
- `invoke(input)`: `const envelope = this.buildEnvelope(input); const outcome = await this.selectTransport(envelope.toolName).invoke(envelope, { timeoutMs: this.requestTimeoutMs }); return this.mapOutcome(outcome, envelope.requestId);` — `buildEnvelope` (ids, T0.6 derivation, deadline) unchanged.
- `mapOutcome`: `terminal` → `mapTerminalResult(result)`; `in_progress` → `{ kind:'in_progress', requestId, correlationId }`; `transport_error` → `transportError(envelope.requestId, message)` — exactly today's mapping.
- `PollOptions` += `toolName?: string` (selects whose status capability; absent → `protocol`). `poll`: deadline check, sleep, `deadline.expired` synthesis unchanged; per iteration `transport.lookupStatus(requestId, { timeoutMs: this.requestTimeoutMs, deadlineAt: opts.deadlineAt })`; no capability → return failure `precondition.not_ready`, `retryable: false`, message `'status lookup is not supported by this backend transport; re-issue the invocation with the same idempotency key'`.
- **NEW `invokeAndAwait(input: InvokeToolInput & { deadlineAt: string }, opts?: { pollIntervalMs?: number })`** — T0.6's D-e logic **moved verbatim** from `apps/worker/src/traderton/write-adapter.ts` (P3-n12): mint `correlationId` once; invoke; one same-key re-issue on `transport_error` while before `deadlineAt`; re-issue `deadline.expired` → keep the original `transport_error`; never after terminal. Then `in_progress` → `awaitTerminal`: if `selectTransport(toolName).lookupStatus` exists → existing `poll` loop (REST: identical to today); else loop { deadline check → `deadline.expired`; sleep `min(interval, remaining)`; re-`invoke` the identical input } until non-`in_progress` (D15; never re-issues past the deadline — T0.6 R1).
- Worker `write-adapter.ts invokeAndAwait` → thin delegate: `client.invokeAndAwait({ ...ids, toolName, payload, subject, deadlineAt: new Date(Date.now() + input.deadlineMs).toISOString() })`. `invoke` passthrough + `createSubjectBoundWriteBoundary` unchanged.
- Per-attempt timeout stays `requestTimeoutMs` (REST parity). Deadline-derived timeout is a T2.3 decision, computed in one client method; seam unchanged either way (P3-n18).
- "Health gating": none exists today; none added (§9 R8).

### MCP fit (T2.3 adds only `transports/mcp-transport.ts` + one factory line)
`McpTransport implements ExternalBackendTransport` without `lookupStatus`. `invoke(invocation, attempt)` sends JSON-RPC `tools/call` with `params.name = invocation.toolName`, `params.arguments = invocation.payload`, and `params._meta = { contractVersion, requestId, idempotencyKey, correlationId, issuedAt, deadlineAt, caller, subject }` taken from the same invocation (I5). The SDK client's `fetch` is wrapped by a signing middleware that calls the unmodified `signRequest(identity, { method: 'POST', path: mcpPath, rawBody: <exact outgoing frame bytes>, deadlineAt })` (D15; spike gate 1 must pass first). Per-call `timeout: attempt.timeoutMs` overrides the SDK's 60 s default; the number comes from above the seam. `CallToolResult` with `structuredContent` → `terminal` (success or `isError` failure envelope, closed code union preserved); backend in-progress indication → `in_progress`; HTTP/JSON-RPC errors → `transport_error`. Because it has no `lookupStatus`, the client's `awaitTerminal` resolves `in_progress` by a same-key re-issue, and `poll(requestId)` returns the typed unsupported failure. Neither the client, the worker adapters nor the contract suites need code changes beyond appending `'mcp'` to the transport list.

### C3 tests
- Existing `client.test.ts`, `client-signing-vectors.test.ts`, `sign.test.ts`, `signing-vectors.test.ts`: **green unmodified** (REST behaviour + bytes).
- T0.6 `write-idempotency.contract.test.ts` + call-site characterisation tests: **green unmodified** — the behavioural proof the move of `invokeAndAwait` changed nothing.
- NEW `transports/rest-transport.test.ts` (fetch stub): `maps a terminal tool result to a terminal outcome`; `maps an in_progress status to in_progress`; `unwraps a terminal status into its result`; `reports a transport error with the original message for a rejected fetch, a non-2xx status and an unreadable body`; `status lookup returns a not_found tool result as terminal instead of looping`; `signs the invoke body bytes it sends` (headers equal `signInvoke` over `rawBody`).
- NEW `transports/select-transport.test.ts`: `uses the endpoint protocol for every tool by default`; `uses a per-tool override when present`; `refuses at construction a protocol with no registered transport`.
- NEW `client-await.test.ts` — fake transports via `vi.mock('./transports/select-transport.js', …)` (no ctor injection → nothing transport-typed in the public surface, P3-n13). Moved from T0.6 `write-adapter.test.ts`: `re-issues once with the same key, requestId, payload and deadline when the first attempt's outcome is unknown`; `does not re-issue after a terminal failure, even a retryable one`; `does not re-issue once the deadline has passed`; `keeps the original transport error when the re-issue reports deadline.expired`. New: `resolves in_progress through the transport's status lookup when it has one`; `resolves in_progress by re-issuing the same invocation when the transport has no status lookup`; `stops resolving at the deadline with deadline.expired`; `poll reports a typed unsupported failure when the transport has no status lookup`.
- `apps/worker/src/traderton/write-adapter.test.ts`: keep `subject-bound write boundary mints …`; replace the moved cases with `invokeAndAwait delegates with a deadline derived from deadlineMs and the caller's idempotency key`.

```sh
pnpm --filter @herobids/domain build
pnpm exec vitest run packages/domain/src/external-backend apps/worker/src/traderton \
  apps/worker/src/agents/agent-decision-handler.test.ts apps/worker/src/agents/agent-broker.test.ts \
  apps/worker/src/services/approval-service.test.ts apps/worker/src/tools/risk-limits.test.ts apps/worker/src/tools/watch.test.ts
pnpm exec vitest run apps/api
pnpm build && pnpm lint
# + I2, I3, I3b, I5 (§5)
```

---

## 4. T1.3

### C4 — registry wiring + the 6 lookups

**Schema** (`packages/domain/src/config/schema.ts`): delete `BoundaryConfigSchema` (`:1561-1585`), `boundary:` (`:1631`), the L3a comment block in `superRefine` (`:1771-1775`), `BoundaryConfig` type (`:1813`) and their `config/index.ts` exports (`:26,149`). Add `externalBackends: ExternalBackendRegistrySchema` and `tradingBackendId: z.string().min(1).optional()` (doc: registry entry used by the first-party trading call sites; pre-Step-12 binding, removed with those sites at Step 14 — P3-n9). `superRefine`: `tradingBackendId` set but not registered → issue at `['tradingBackendId']`. Startup stays lenient on a missing secret (no behaviour change).

**`config/default.yaml`** (replace `:381-388`):
```yaml
# External Backend registry (Step 10 §1) — operator registration records, keyed by backendId.
# Transport + trust metadata ONLY (ADR 015 §3). Parsed into ExternalBackendDefinition[].
externalBackends:
  traderton:
    enabled: true
    endpoint:
      baseUrl: http://localhost:8080        # local compose boundary; override: TRADERTON_BOUNDARY_URL
      contractVersion: "1.0"                # 005 invocation envelope version
      protocol: rest                        # rest | mcp; mcp only in development/test (D19), YAML only
      # toolProtocolOverrides: {}           # optional per-tool protocol; absent = every tool uses `protocol`
      # mcpPath: /mcp                       # required when protocol or any override is mcp
      requestTimeoutMs: 10000               # per-request timeout (ms); override: TRADERTON_BOUNDARY_TIMEOUT_MS
    caller:
      consumerId: herobids                  # override: TRADERTON_BOUNDARY_CONSUMER_ID
      keyId: current                        # override: TRADERTON_BOUNDARY_KEY_ID
      hmacSecretRef: TRADERTON_BOUNDARY_HMAC_SECRET   # NAME of the env var holding the HMAC secret — never the secret
    health:
      readyPath: /health/ready              # carried for later health gating; unread in Step 11
    trustedDescriptorSigningKeys: []        # ed25519 public keys (dev key at T4.2)
    approvedSourceSkillRefs:                # D11
      - traderton/skills/crypto-trading
      - traderton/skills/crypto-bot-management
      - traderton/skills/crypto-risk-monitoring
    descriptorPinning:
      mode: maxAge
      seconds: 3600
# Registry entry the first-party trading call sites use until Step 14 removes them.
tradingBackendId: traderton
```
`idempotencyRetentionHours` dropped (unread). `config/{development,staging,production}.yaml`: no boundary keys today → no change.

**Loaders** (`apps/worker/src/config.ts`, `apps/api/src/config.ts` — keep them mirrored):
- `ENV_OVERRIDES`: `TRADERTON_BOUNDARY_URL → externalBackends.traderton.endpoint.baseUrl`, `_CONSUMER_ID → …caller.consumerId`, `_KEY_ID → …caller.keyId`, `_TIMEOUT_MS → …endpoint.requestTimeoutMs` (number). **Remove** `TRADERTON_BOUNDARY_HMAC_SECRET` from the map (now the ref's value). Same env names → local stack, xstack overlay and staging env files keep working (P3-n8). Update the api comment `:66-70`.
- After `AppConfigSchema.parse`: `const violations = findExternalBackendProtocolViolations(config.externalBackends, env); if (violations.length > 0) throw new Error(…)` (D19, next to the billing check).
- `export function resolveConfiguredExternalBackend(config: AppConfig, backendId: string | undefined): Result<ResolvedExternalBackend>` = `resolveExternalBackend(config.externalBackends, backendId, process.env)` — the only `process.env` read for secrets stays in the loader module (best-practice principle 3).

**Sites** (each: lookup by `appConfig.tradingBackendId`; no `'traderton'` literal in TS):

| # | Site (`8d30dd46`) | After |
|---|---|---|
| top | worker `index.ts` | `const tradingBackend = resolveConfiguredExternalBackend(appConfig, appConfig.tradingBackendId);` `const tradingBackendTimeoutMs = findExternalBackend(appConfig.externalBackends, appConfig.tradingBackendId)?.endpoint.requestTimeoutMs ?? DEFAULT_EXTERNAL_BACKEND_REQUEST_TIMEOUT_MS;` |
| S1 | worker `index.ts:431-449` (`:440`) `sideEffectBoundary` | `if (!tradingBackend.ok) { logger.info({ backendId, reason: tradingBackend.error.code }, <same text>); return undefined; }` → `createExternalBackendClient(buildExternalBackendClientConfig(def, secret))` → write boundary |
| S2 | `:459-477` (`:468`) `systemReadBoundary` | same; subject `ownerId: def.caller.consumerId`; deadline `def.endpoint.requestTimeoutMs` |
| S3 | `:493-511` (`:502`) `alertDispatcherFeed` | same as S2 |
| S4 | `:785-799` (`:794`) `evaluationReadClient`; `:813` | same; `tradertonReadTimeoutMs: tradingBackendTimeoutMs` (field name kept) |
| P1/P2 | `:286`, `:340` `boundaryConfigJson: JSON.stringify(appConfig.boundary)` | `...(tradingBackend.ok ? { externalBackendConfigJson: JSON.stringify(tradingBackend.data) } : {})` |
| P3 | `agents/runtime-lifecycle.ts:41,170`; `agents/docker-agent-manager.ts:74,152,198,295` | field `externalBackendConfigJson`; env `EXTERNAL_BACKEND_CONFIG_JSON` (P3-n17) |
| S5 | worker `agent.ts:122` + `buildTradertonBoundaries` `:904-955` (`:938`) | extract NEW `apps/worker/src/external-backend/agent-ports.ts` (+ test; imports the adapters from `../traderton/` until C5 moves them) `buildAgentExternalBackendPorts({ rawConfigJson, ownerId, agentId, logger })`: `ResolvedExternalBackendSchema.parse(JSON.parse(raw))` → `buildExternalBackendClientConfig` → client → read boundary + `createSubjectBoundWriteBoundary`; absent/invalid/no owner → `{ read: undefined, write: undefined }` (same as today). `agent.ts` locals → `externalBackendRead` / `externalBackendWrite`; B7 error text names `EXTERNAL_BACKEND_CONFIG_JSON` |
| S6 | api `index.ts:197-205` (`:198`) `tradertonBotClient`; timeouts `:218,277,289,302,308-311,318,320,345,363` | `const tradingBackendClient = tradingBackend.ok ? createExternalBackendClient(buildExternalBackendClientConfig(...)) : undefined;` + `tradingBackendTimeoutMs`; positional args → no route signature change |

**Env twins / drift guard (I11):** no new env key. `.env.example:179-180` comment header only ("external backend `traderton` — env overrides for `config/default.yaml externalBackends.traderton` + the secret named by `caller.hmacSecretRef`"); values/keys unchanged. `infra/hetzner/.env.environment.example`: no change (same names). `apps/worker/src/env-example-drift.test.ts`: `IGNORED_ENV_VARS` `BOUNDARY_CONFIG_JSON` → `EXTERNAL_BACKEND_CONFIG_JSON`; new helper parses `default.yaml` (`yaml` package) and collects every `externalBackends.*.caller.hmacSecretRef`; those names count as code-read (stale check) and get a new case `documents every external-backend hmacSecretRef named in default.yaml`.

**C4 tests**
- worker + api `config.test.ts`: `maps the TRADERTON_BOUNDARY_* overrides onto externalBackends.traderton`; `rejects protocol mcp when NODE_ENV is staging` / `… production`; `allows protocol mcp with an mcpPath in development`; `rejects a tradingBackendId that names no registered backend`; `resolveConfiguredExternalBackend reads the secret from the env var named by hmacSecretRef`; parity: `the default traderton entry yields the client config the boundary block produced` (`{ baseUrl:'http://localhost:8080', consumerId:'herobids', keyId:'current', requestTimeoutMs:10000, hmacSecret, protocol:'rest' }`).
- `agent-ports.test.ts`: `round-trips the worker's resolved payload into read and write ports bound to the agent subject`; `returns no ports when the payload is absent, invalid or the agent has no owner`.
- drift test (extended) green.

```sh
pnpm build && pnpm lint
pnpm exec vitest run apps/worker/src/config.test.ts apps/api/src/config.test.ts apps/worker/src/env-example-drift.test.ts apps/worker/src/traderton apps/worker/src/external-backend packages/domain/src/config
pnpm exec vitest run apps/api apps/worker packages/domain
rg -n "appConfig\.boundary|BoundaryConfig|BOUNDARY_CONFIG_JSON|boundaryConfigJson" apps packages -g '!dist'   # expect none
# Local stack smoke (real HMAC into the local boundary): G3 first; rebuild the agent image (payload env renamed), then
scripts/shell/tests/run-all-tests.sh --e2e      # at least once before C5; compare with G0
```

### C5 — ctx ports, read-result type, worker adapters

| From | To | Scope |
|---|---|---|
| `TradingToolContext.tradertonBoundary?` | `externalBackend?` | `packages/domain/src/trading/tool-contract.ts:165` + uses (99 occ., 22 files: worker `tools/*` + tests, `agent.ts:1824`, adapters, `market-intelligence/preset-scorecard-runner.ts` comment) |
| `TradingToolContext.tradertonWriteBoundary?` | `externalBackendWrite?` | `tool-contract.ts:181` + `agent.ts`, `tools/{risk-limits,watch}(.test).ts`, T0.6 `createSubjectBoundWriteBoundary` return type |
| `TradertonReadResult` | `ExternalBackendReadResult` (stays in `tool-contract.ts` until the Step 15 split; P3-n16) | domain barrel `index.ts:26` + 24 files (api `routes/{bots,connections,exports-traderton}.ts`, `traderton-operator-defaults.test.ts` = forced type rename only) |
| `apps/worker/src/traderton/{read-adapter,read-adapter.test,write-adapter,write-adapter.test,write-idempotency.contract.test}.ts`, `__tests__/fake-idempotent-boundary.ts` | `git mv` → `apps/worker/src/external-backend/` (joins C4's `agent-ports.ts`) | worker |
| `TradertonReadBoundary` / `createTradertonReadBoundary` | `ExternalBackendReadBoundary` / `createExternalBackendReadBoundary` | **`apps/worker/` only** (api has same-named CF-11 symbols) |
| `TradertonSideEffectBoundary` / `createTradertonSideEffectBoundary` | `ExternalBackendWriteBoundary` / `createExternalBackendWriteBoundary` | `apps/worker/` |
| `apps/worker/src/tools/traderton-read.ts` | `git mv` → `tools/external-backend-result.ts` (generic read/write result → ToolResult mapping Step 12 reuses) | 9 importers in `tools/` |
| import paths `traderton/read-adapter.js`, `traderton/write-adapter.js`, `traderton-read.js` | `external-backend/…`, `external-backend-result.js` | worker (`agent.ts`, `index.ts`, `agent-evaluation/run-evaluation.ts`, `alerting/boundary-trade-event-feed(.test).ts`, `traderton/hybrid-price-adapter(.test).ts`, `agents/{agent-message-broker,agent-decision-handler(.test),agent-broker.test}.ts`, `services/approval-service(.test).ts`) |

`\btradertonBoundary\b` does not match `tradertonBoundaryAvailable` (kept). Update the doc comments on the two ports (generic wording).

**Explicitly NOT renamed in Phase 3 Block 1**

| Item | Why |
|---|---|
| Wire headers `x-traderton-*`, `x-request-deadline-at`; `sign.ts` content | Frozen REST bytes (§5) |
| Env names `TRADERTON_BOUNDARY_*` | Deployed staging env + local stack (P3-n8) |
| `apps/worker/src/traderton/{hybrid-price-adapter,price-contracts}(.test).ts` (dir stays) | Trading semantics (`PriceService`, `resolve_price_target`) — Step 14/15 |
| api `routes/exports-traderton.ts` (+ its `TradertonReadBoundary`/`createTradertonReadBoundary`), `traderton-operator-defaults.ts`, `agents/trading-profile-reconciliation-saga.ts` | CF-11, untouched except forced type/import renames |
| Consumer-local names `tradertonClient`, `tradertonReadClient`, `tradertonReadTimeoutMs`, `tradertonBotClient` param/field names (~204 occ. in api routes/services, worker evaluation runtime) | Trading consumers Steps 14/15 delete or move (P3-n16); only the two composition-root locals at S5/S6 are renamed |
| `tradertonBoundaryAvailable` (`agent-capabilities.ts:23`) | Trading capability gate — T3.2 |
| `packages/domain/src/trading/**` other than the two ports + read-result type | Step 15 |
| Prose "Traderton" in comments/log text outside rewritten lines; historical docs | Not contract; history |

```sh
pnpm build && pnpm lint
pnpm exec vitest run packages/domain apps/worker apps/api
rg -nw -g '!dist' "tradertonBoundary|tradertonWriteBoundary|TradertonReadResult" apps packages                    # expect none
rg -nw -g '!dist' "TradertonReadBoundary|createTradertonReadBoundary|TradertonSideEffectBoundary|createTradertonSideEffectBoundary" apps/worker   # expect none
rg -nw "TradertonReadBoundary|createTradertonReadBoundary" apps/api                                                # expect hits (CF-11, intended)
rg -n "traderton-read\.js|traderton/(read|write)-adapter\.js" apps                                                 # expect none
```

---

## 5. Block-end invariant checks (after C5; also run the relevant ones per commit)

| Inv | Command | Expected |
|---|---|---|
| G3/I8 | `env \| grep TRADERTON_`; `rg -n TRADERTON_BOUNDARY_URL .env`; `echo "${BOUNDARY_BASE_URL:-unset}"` | empty; no match; `unset` |
| I1 (no regression) | `rg -n "'traderton'\|\"traderton\"" apps packages -g '!*.test.ts' -g '!dist'`; `rg -n "backendId\s*[!=]==\s*['\"]" apps packages -g '!dist'` | none; none. (I1's own file list: count ≤ T0.2 baseline, no new hits) |
| I2 | `rg -n "RestTransport\|McpTransport" packages/domain/src/external-backend/ \| rg -v "transports/\|index.ts\|\.test\.ts"` | none |
| I3 | `rg -n "Transport" packages/domain/package.json`; `rg -n "export .*Transport" packages/domain/src/external-backend/index.ts` | none; none |
| I3b | `rg -n "transports/" packages/domain/dist/external-backend/index.d.ts packages/domain/dist/external-backend/client.d.ts packages/domain/dist/external-backend/client-config.d.ts` | none (no seam type reachable from the public d.ts) |
| I4 | `pnpm --filter @herobids/domain exec vitest run src/external-backend/sign.test.ts`; `… -t "signing vectors"`; R100 blob check (C1); `shasum -a 256 …/invocation-signing-vectors.json`; tt read-only: `pnpm exec vitest run packages/boundary/src/signing-vectors.test.ts` | green; green; R100; = SEAM §3.1; green |
| I5 | `rg -n "requestId\|idempotencyKey" packages/domain/src/external-backend/transports/*.ts` | hits in `transport.ts` (`TransportInvocation`, `lookupStatus`) and `rest-transport.ts` |
| I7 | `git diff "$T1_BASE"...HEAD -- '*.ts' \| rg -n "^\+.*(\bas unknown as\b\|@ts-ignore\|@ts-expect-error\|: *any\b)"` | none. A hit on a pre-existing line touched only by a rename (e.g. `client.test.ts` `as unknown as Response` if its line changed) → list it with `git diff --word-diff` in the running notes |
| I11 | `pnpm exec vitest run apps/worker/src/env-example-drift.test.ts`; `git diff "$T1_BASE"...HEAD -- '*.env*.example' '.env.example'` | green; comment-only |
| G2 | `scripts/shell/tests/run-all-tests.sh --e2e`, `scripts/shell/tests/run-extra-tests.sh --all` (herobids; default gates, never `RUN_UNSTABLE_LLM_LATENCY_TESTS=1`) | no regression vs G0 |

I12 note for closeout (record, don't fix here): after Block 1 a second backend registers with **config only** (YAML entry + its own `hmacSecretRef` env var); clients build generically. Remaining code-bound items: the `TRADERTON_BOUNDARY_*` ENV_OVERRIDES rows (optional convenience; a second backend needs none), the `tradingBackendId` binding of the first-party trading sites (Step 14), and tool visibility (T3.2).

---

## 6. Test strategy

- **Unit (vitest, no services, run in `run-all-tests.sh` step 1):** C2 schema/helpers; C3 RestTransport, selector, client-await (fake transports via `vi.mock`), adapter delegation; C4 loader mapping/D19/resolution/parity + agent-ports round-trip + drift guard.
- **Behavioural parity guards (must pass unmodified apart from C1/C5 renames):** `sign.test.ts`, `signing-vectors.test.ts` (byte-unmodified), `client-signing-vectors.test.ts`, `client.test.ts`, T0.6 `write-idempotency.contract.test.ts` and call-site characterisation tests.
- **Integration/E2E:** `run-all-tests.sh --e2e` after C4 and at block end — real HMAC over HTTP into the local Postgres-backed boundary; this is the only check of the env→registry→client→agent-payload chain end to end. Rebuild the agent image first.
- **Visual:** none (no UI change).

---

## 7. DECISIONS rows (append to Phase-3 `DECISIONS.md` §3; assign the next free P3 numbers — Block 0 uses ~P3-1..P3-5)

| # | Decision | Rationale (one line) |
|---|---|---|
| P3-n1 | Rename via `git mv`; `sign.ts`, `sign.test.ts`, `signing-vectors.test.ts`, fixtures stay byte-identical (R100); `sign.ts` symbols and `x-traderton-*` headers kept | Blob identity is the strongest §5 evidence; the signer symbols are already generic and the headers are wire bytes |
| P3-n2 | `TradertonBoundaryFailureCode` → `ExternalBackendFailureCode` | The closed 005 union belongs to the backend contract; "Boundary" adds nothing once the prefix is generic |
| P3-n3 | Keep `InvokeToolInput`, `PollOptions`, `SigningIdentity`, `deriveRequestId` names | Already generic; not in Step 10 §2; less churn |
| P3-n4 | Definition + Zod + pure helpers in `packages/domain/src/config/external-backends.ts`, not the node-only subpath | `AppConfigSchema` needs it, and config must not depend on the crypto/fetch module |
| P3-n5 | YAML registry is a map keyed by `backendId`, parsed to `ExternalBackendDefinition[]` | `deepMerge` replaces arrays and env overrides/drift guard address dotted keys; a map also makes duplicate ids impossible |
| P3-n6 | Add `endpoint.requestTimeoutMs`; drop `idempotencyRetentionHours` | The timeout is read at ~15 sites; the retention value is informational and unread |
| P3-n7 | `caller.hmacSecretRef` = env var NAME, resolved by the app config loaders through a pure domain helper (`Result`); the agent receives the resolved record in `EXTERNAL_BACKEND_CONFIG_JSON` | No secret in `AppConfig`; `process.env` stays in the loader; same secret-in-payload posture as today's `BOUNDARY_CONFIG_JSON` |
| P3-n8 | Keep `TRADERTON_BOUNDARY_{URL,CONSUMER_ID,KEY_ID,TIMEOUT_MS}` as ENV_OVERRIDES rows targeting `externalBackends.traderton.*`; `TRADERTON_BOUNDARY_HMAC_SECRET` becomes the ref value | Deployed staging env and the local stack set these names; renaming them is an operator env change; no new env key |
| P3-n9 | First-party trading sites bind via config `tradingBackendId` | Keeps backend identity out of TS code (0 literals) and makes the binding operator config; removed at Step 14 |
| P3-n10 | Protocol: Zod enum `rest\|mcp`; `mcpPath` required for mcp; loader rejects mcp outside development/test (D19, permanent); client construction rejects a protocol with no registered transport (mcp until T2.3) | Fail-fast at startup on both the policy and the availability axis |
| P3-n11 | Seam = `invoke(invocation, attempt)` + optional `lookupStatus(requestId, attempt)`; `in_progress` resolution chosen by capability in the client | §2.4 forbids retry policy below the seam, and a same-key re-issue is a retry |
| P3-n12 | Move T0.6's `invokeAndAwait` reconcile orchestration from the worker write adapter into `ExternalBackendClient.invokeAndAwait` | Orchestration belongs above the seam, and MCP's re-issue needs the invocation only the client holds |
| P3-n13 | Seam unit tests isolate via `vi.mock('./transports/select-transport.js')`, no constructor injection | Keeps every transport type out of the public d.ts (I3) |
| P3-n14 | Add a root vitest alias for `@herobids/domain/external-backend` | Verified: the `@herobids/domain` alias prefix-matches the subpath to a non-existent file, breaking value imports |
| P3-n15 | Registry wiring + site lookups land together in T1.3-C4; T1.1 ships the schema unwired | Removing `boundary` breaks the sites; keeping both is a D6 shim with a split env-override target |
| P3-n16 | Rename the generic surface only (module, contract/client types, ctx ports, `ExternalBackendReadResult`, worker read/write adapters → `apps/worker/src/external-backend/`, `tools/external-backend-result.ts`); leave trading consumers' local names, `hybrid-price`/`price-contracts`, and CF-11 files | Steps 14/15 delete or move those consumers; renaming them now is churn without genericity gain |
| P3-n17 | Agent payload env `BOUNDARY_CONFIG_JSON` → `EXTERNAL_BACKEND_CONFIG_JSON` | Its shape changes; internal worker→agent contract, built from the same commit |
| P3-n18 | REST per-attempt timeout stays `requestTimeoutMs`; a deadline-derived timeout is T2.3's call, computed in one client method | Exact REST parity now; seam unchanged either way; adopting it for REST later = a recorded IV row |

None needs Contemplator routing (each has a one-sentence deciding reason); none touches an invariant, a recorded decision or infra.

---

## 8. Records to update (per commit)

- `TASKS.md`: T1.1 (after C2) / T1.2 (C3) / T1.3 (C5) status + cursor + running notes (SHA, sub-agents, test counts, R100 proof, invariant outputs). Note P3-n15 under T1.1. Under T2.3: add "register `mcp` in `transports/select-transport.ts`; decide P3-n18; `poll(requestId)` is unsupported on MCP tools". Note the corrected vitest-resolution fact (P3-n14).
- `DECISIONS.md` §3: rows above. §4: no new IV row (no behaviour change).
- Step 10 plan: §1 config-migration + §2 table amendments (C2), §2.4 note on `lookupStatus` capability + client-side re-issue (C3) — doc before code (SEAM §4).
- `SEAM.md` §3.1/§3.2 fixture path note (C1). Program `PROGRESS.md` Step 11 row (C5).
- `.github/skills/{external-backend-genericization,trading-boundary-ops}/SKILL.md` paths (C1); config/env notes (C4).

---

## 9. Risks / open questions (none blocks)

- **R1 Inventory drift.** Block 0 lands first and shifts lines/files; re-run every `rg` inventory before editing. The worker T0.6 files may differ from the T0.6 plan.
- **R2 Regex collateral.** Worker-adapter renames must not touch api's CF-11 `TradertonReadBoundary`; scope C5 to `apps/worker/`. Use `perl -pi` with `\b`; review `git diff --stat` per directory.
- **R3 C3 moves T0.6 logic.** Guarded by the unmodified contract suite and the moved unit tests. If any T0.6 characterisation test needs an edit beyond renames, stop and diagnose: that signals a behaviour change.
- **R4 Worker↔agent payload.** A stale agent image reads no `EXTERNAL_BACKEND_CONFIG_JSON` → trading agents hit the B7 startup error (loud, not silent). Rebuild the agent image before E2E.
- **R5 `setNestedValue` partial entries.** An env override set while the YAML lacks `externalBackends.traderton` creates a partial entry → Zod error at startup (fail-fast, acceptable).
- **R6 Host-run processes.** Secrets resolve from `process.env` at runtime; compose `env_file: .env` supplies them in containers. A host-run `pnpm dev` api/worker needs `.env` loaded the same way as today (unchanged).
- **R7 `lookupStatus` `this` binding.** Always call `transport.lookupStatus(...)`; never destructure it.
- **R8 Health gating gap.** Step 10 §2.4 lists health gating above the seam, but none exists today; `health.readyPath` is carried, unread. Adding gating would be a behaviour change → park in Outstanding Issues for Step 12/16.
- **R9 `pnpm lint` checks nothing** (pre-existing); `pnpm build` is the gate. Park as LOW if not already parked by Block 0.
- **Q** No operator question. Handoff: ready for Implementer once Block 0 (T0.3–T0.6) is committed.

## 10. Out of scope
`McpTransport` and the backend MCP surface (T2.x); descriptor verification and visibility (T3.x); deadline-derived REST timeout; renaming trading consumers or CF-11 surfaces; any traderton edit; staging contact; `RUN_UNSTABLE_LLM_LATENCY_TESTS`.

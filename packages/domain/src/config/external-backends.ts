// External Backend registration records (Step 10 §1, ADR 015 §3): generic
// transport + trust metadata ONLY. Pure Zod with no node imports, so the main
// barrel (which reaches apps/web) can carry it. Dependency direction: the
// node-only client subpath may import this module; this module never imports it.
import { z } from 'zod';
import { ok, err, type Result } from '../result.js';

/** The herobids-owned protocol set (DT2). */
export const EXTERNAL_BACKEND_PROTOCOLS = ['rest', 'mcp'] as const;
export type ExternalBackendProtocol = (typeof EXTERNAL_BACKEND_PROTOCOLS)[number];
export const DEFAULT_EXTERNAL_BACKEND_PROTOCOL: ExternalBackendProtocol = 'rest';
/** Same default as the boundary block this registry replaces. */
export const DEFAULT_EXTERNAL_BACKEND_REQUEST_TIMEOUT_MS = 10_000;
/** D19: environments where protocol 'mcp' may be configured. */
export const MCP_ALLOWED_ENVIRONMENTS = ['development', 'test'] as const;

export const ExternalBackendProtocolSchema = z.enum(EXTERNAL_BACKEND_PROTOCOLS);
const BackendIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'backendId must be lowercase kebab-case');
// A NAME of an environment variable, never the secret itself.
const EnvVarNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'hmacSecretRef must be an environment variable name (A-Z, 0-9, _)');
const ToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'tool names are lower snake case');
// D11 skills.sh ref: owner/repo/skill. No segment may be `.` or `..`.
const SKILL_REF_SEGMENT = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9._-]+`;
const SkillRefSchema = z
  .string()
  .regex(
    new RegExp(`^${SKILL_REF_SEGMENT}/${SKILL_REF_SEGMENT}/${SKILL_REF_SEGMENT}$`),
    'skill refs are owner/repo/skill',
  );
// http(s) only, no userinfo: a scheme-less typo must fail at startup, and
// credentials in a URL would reach every log line that prints it.
const BaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
  }, 'baseUrl must be an http(s) URL without credentials');
/** setTimeout/AbortSignal.timeout overflow above 2^31−1 ms. */
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;

// Strict at every level: this is trust metadata, and a silently dropped typo
// (`enable: false`) would fail open.
const ExternalBackendEntryObject = z.object({
  enabled: z.boolean().default(true),
  endpoint: z.object({
    baseUrl: BaseUrlSchema,
    contractVersion: z.literal('1.0').default('1.0'),
    protocol: ExternalBackendProtocolSchema.default(DEFAULT_EXTERNAL_BACKEND_PROTOCOL),
    toolProtocolOverrides: z.record(ToolNameSchema, ExternalBackendProtocolSchema).optional(),
    mcpPath: z.string().regex(/^\/[^?#]*$/, 'mcpPath must be an absolute path without query or fragment').optional(),
    requestTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(MAX_REQUEST_TIMEOUT_MS)
      .default(DEFAULT_EXTERNAL_BACKEND_REQUEST_TIMEOUT_MS),
    /**
     * Bounded retry for a single `tools/list` discovery call (docs/features/
     * 2026/10/05/001-backend-tool-discovery-retry). Closes the "one transient
     * failure strands the agent without trading tools all session" gap without
     * widening the no-retry transport contract. Tool CALLS are unaffected —
     * this only covers discovery.
     */
    discoveryRetry: z.object({
      maxAttempts: z.number().int().min(1).default(3),
      baseDelayMs: z.number().int().min(1).default(250),
      maxDelayMs: z.number().int().min(1).default(2_000),
    }).strict().default({}),
  }).strict(),
  caller: z.object({
    consumerId: z.string().min(1),
    keyId: z.string().min(1),
    hmacSecretRef: EnvVarNameSchema,
  }).strict(),
  health: z.object({ readyPath: z.string().regex(/^\//).default('/health/ready') }).strict().default({}),
  approvedSourceSkillRefs: z.array(SkillRefSchema).default([]),
  /**
   * ONE connection family (ADR 017 §3, D28) inherited by every approved skill of
   * this backend. An agent assigned an approved ref gets this family's
   * capability — driving readiness, the startup guard, tick-work and
   * GET /capabilities. For Traderton it is the opaque label `trading`. Optional:
   * a backend may expose approved skills that need no connection.
   */
  requiresConnectionFamily: z.string().regex(/^[a-z][a-z0-9-]*$/, 'connection family is lowercase kebab-case').optional(),
}).strict();
type ExternalBackendEntry = z.infer<typeof ExternalBackendEntryObject>;

function refineExternalBackendEntry(entry: ExternalBackendEntry, ctx: z.RefinementCtx): void {
  const usesMcp =
    entry.endpoint.protocol === 'mcp' ||
    Object.values(entry.endpoint.toolProtocolOverrides ?? {}).includes('mcp');
  if (usesMcp && entry.endpoint.mcpPath === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endpoint', 'mcpPath'],
      message: 'mcpPath is required when the protocol or any tool override is mcp',
    });
  }
  const seenSkillRefs = new Set<string>();
  entry.approvedSourceSkillRefs.forEach((ref, index) => {
    if (seenSkillRefs.has(ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvedSourceSkillRefs', index],
        message: `duplicate approved skill ref "${ref}"`,
      });
    }
    seenSkillRefs.add(ref);
  });
}

const ExternalBackendEntrySchema = ExternalBackendEntryObject.superRefine(refineExternalBackendEntry);

export const ExternalBackendDefinitionSchema = ExternalBackendEntryObject.extend({
  backendId: BackendIdSchema,
}).superRefine(refineExternalBackendEntry);
export type ExternalBackendDefinition = z.infer<typeof ExternalBackendDefinitionSchema>;

/**
 * YAML shape: a map keyed by backendId; parsed shape: ExternalBackendDefinition[].
 * Input and output types differ, so never re-parse an already-parsed AppConfig.
 */
export const ExternalBackendRegistrySchema = z
  .record(BackendIdSchema, ExternalBackendEntrySchema)
  .default({})
  .transform((entries): ExternalBackendDefinition[] =>
    Object.entries(entries).map(([backendId, entry]) => ({ backendId, ...entry })),
  );

/** Worker → agent container payload: the definition plus its resolved HMAC secret. */
export const ResolvedExternalBackendSchema = z.object({
  definition: ExternalBackendDefinitionSchema,
  hmacSecret: z.string().min(1),
});
export type ResolvedExternalBackend = z.infer<typeof ResolvedExternalBackendSchema>;

export function findExternalBackend(
  registry: readonly ExternalBackendDefinition[],
  backendId: string | undefined,
): ExternalBackendDefinition | undefined {
  if (backendId === undefined) return undefined;
  return registry.find((definition) => definition.backendId === backendId);
}

/** Pure: `env` is injected (only the app config loaders pass process.env). */
export function resolveExternalBackend(
  registry: readonly ExternalBackendDefinition[],
  backendId: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Result<ResolvedExternalBackend> {
  if (backendId === undefined) {
    return err({ code: 'external_backend.not_selected', message: 'no external backend is selected' });
  }
  const definition = findExternalBackend(registry, backendId);
  if (definition === undefined) {
    return err({
      code: 'external_backend.not_registered',
      message: `external backend "${backendId}" is not registered`,
      context: { backendId },
    });
  }
  if (!definition.enabled) {
    return err({
      code: 'external_backend.disabled',
      message: `external backend "${backendId}" is disabled`,
      context: { backendId },
    });
  }
  const { hmacSecretRef } = definition.caller;
  const hmacSecret = env[hmacSecretRef];
  if (hmacSecret === undefined || hmacSecret === '') {
    return err({
      code: 'external_backend.secret_missing',
      message: `external backend "${backendId}": environment variable ${hmacSecretRef} (hmacSecretRef) is unset or empty`,
      context: { backendId, hmacSecretRef },
    });
  }
  return ok({ definition, hmacSecret });
}

/** D19: one message per 'mcp' use (protocol or tool override) when environment ∉ MCP_ALLOWED_ENVIRONMENTS. */
export function findExternalBackendProtocolViolations(
  registry: readonly ExternalBackendDefinition[],
  environment: string,
): string[] {
  if (MCP_ALLOWED_ENVIRONMENTS.some((allowed) => allowed === environment)) return [];
  const allowedList = MCP_ALLOWED_ENVIRONMENTS.join('/');
  const violations: string[] = [];
  for (const definition of registry) {
    const prefix = `externalBackends.${definition.backendId}.endpoint`;
    if (definition.endpoint.protocol === 'mcp') {
      violations.push(
        `${prefix}.protocol is mcp, which is only allowed in ${allowedList} (D19); environment is "${environment}"`,
      );
    }
    for (const [toolName, protocol] of Object.entries(definition.endpoint.toolProtocolOverrides ?? {})) {
      if (protocol === 'mcp') {
        violations.push(
          `${prefix}.toolProtocolOverrides.${toolName} is mcp, which is only allowed in ${allowedList} (D19); environment is "${environment}"`,
        );
      }
    }
  }
  return violations;
}

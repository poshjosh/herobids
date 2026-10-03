// Composition root for descriptor-driven tool visibility (Step 12 T3.2 + T3.3).
//
// Sits beside `buildAgentExternalBackendPorts`: both consume the forwarded
// EXTERNAL_BACKEND_CONFIG_JSON. This module turns the forwarded backend definition
// into a trust-policy registry, builds the dev-signed STUB_DESCRIPTOR source
// (T3.3), splices the stub's ephemeral public key into the backend's trust policy
// for the dev/test run, and rewrites a runtime descriptor's resolved skills so the
// visible tool set flows from the signed descriptor via the generic resolver.
//
// It names NO backend: the backendId comes from the forwarded definition, and the
// matcher iterates the registry. When no backend is forwarded (non-trading agent,
// or boundary unconfigured), the resolver still runs with an empty registry → every
// skill is `no_match` → unchanged (ordinary platform skills).
import { ResolvedExternalBackendSchema, SYSTEM_SKILLS, type SkillDefinition } from '@herobids/domain';
import type { DescriptorTrustPolicy } from '@herobids/domain/external-backend';
import {
  applyDescriptorToolVisibility,
  type ApplyToolVisibilityResult,
  type SyncDescriptorSource,
} from './apply-tool-visibility.js';
import { createStubDescriptorSource, type StubToolSchemaLookup } from './stub-descriptor-source.js';

export interface DescriptorToolVisibilityLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface BuildDescriptorToolVisibilityInput {
  /** Raw EXTERNAL_BACKEND_CONFIG_JSON (same payload buildAgentExternalBackendPorts reads). */
  rawConfigJson: string | undefined;
  resolvedSkills: readonly SkillDefinition[];
  /** Resolves a tool name to its registered schema; the stub mirrors these (DT4). */
  lookupToolSchema: StubToolSchemaLookup;
  now: Date;
  logger: DescriptorToolVisibilityLogger;
}

/** The built-in trading skills, used as the stub descriptor's bound source skills. */
const TRADING_SKILL_IDS = new Set(['trading', 'bot-management', 'risk-monitoring']);
const BUILTIN_TRADING_SKILLS: readonly SkillDefinition[] = SYSTEM_SKILLS.filter((skill) =>
  TRADING_SKILL_IDS.has(skill.id),
);

/**
 * Parse the forwarded backend definition into a trust policy, or `undefined` when
 * absent/invalid. The payload may echo input fragments (and carries the HMAC
 * secret), so a parse failure logs a fixed message + issue codes only.
 */
function parseTrustPolicy(
  rawConfigJson: string,
  logger: DescriptorToolVisibilityLogger,
): DescriptorTrustPolicy | undefined {
  let json: unknown;
  try {
    json = JSON.parse(rawConfigJson);
  } catch {
    logger.warn({ reason: 'invalid_json' }, 'Descriptor tool visibility: could not parse EXTERNAL_BACKEND_CONFIG_JSON');
    return undefined;
  }
  const parsed = ResolvedExternalBackendSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path.join('.') }));
    logger.warn({ reason: 'invalid_schema', issues }, 'Descriptor tool visibility: EXTERNAL_BACKEND_CONFIG_JSON failed validation');
    return undefined;
  }
  return parsed.data.definition;
}

/**
 * Rewrite `resolvedSkills` so matched skills expose their backend's descriptor
 * tools (or degrade to instruction-only). Returns the (possibly unchanged) skills
 * plus the per-skill outcomes. The caller swaps the returned skills into the
 * runtime descriptor before composition state is built.
 */
export function buildDescriptorToolVisibility(input: BuildDescriptorToolVisibilityInput): ApplyToolVisibilityResult {
  const { rawConfigJson, resolvedSkills, lookupToolSchema, now, logger } = input;

  if (rawConfigJson === undefined) {
    // No backend forwarded → empty registry → every skill is no_match (unchanged).
    return applyDescriptorToolVisibility({ resolvedSkills, registry: [], descriptorSource: EMPTY_SOURCE, now });
  }

  const definition = parseTrustPolicy(rawConfigJson, logger);
  if (definition === undefined) {
    return applyDescriptorToolVisibility({ resolvedSkills, registry: [], descriptorSource: EMPTY_SOURCE, now });
  }

  // T3.3 dev stub: bind the three D11 refs → the current trading tool schemas and
  // sign with an ephemeral key, then trust that key for this dev/test run by
  // splicing its public key into the forwarded definition's signing keys.
  const stub = createStubDescriptorSource({
    backendId: definition.backendId,
    tradingSkills: BUILTIN_TRADING_SKILLS,
    lookupToolSchema,
    now,
  });
  const registry: DescriptorTrustPolicy[] = [
    {
      ...definition,
      trustedDescriptorSigningKeys: [
        ...definition.trustedDescriptorSigningKeys,
        { keyId: stub.keyId, publicKey: stub.publicKeyPem, status: 'active' },
      ],
    },
  ];

  const result = applyDescriptorToolVisibility({ resolvedSkills, registry, descriptorSource: stub.source, now });
  for (const outcome of result.outcomes) {
    if (outcome.outcome === 'instruction_only') {
      logger.warn(
        { skillId: outcome.skillId, backendId: outcome.backendId, reason: outcome.reason },
        'Descriptor tool visibility: skill degraded to instruction-only',
      );
    } else if (outcome.outcome === 'tools_exposed') {
      logger.info(
        { skillId: outcome.skillId, backendId: outcome.backendId },
        'Descriptor tool visibility: skill tools resolved from signed descriptor',
      );
    }
  }
  return result;
}

/** A source that never returns a descriptor — used when no backend is forwarded. */
const EMPTY_SOURCE: SyncDescriptorSource = { getDescriptor: () => undefined };

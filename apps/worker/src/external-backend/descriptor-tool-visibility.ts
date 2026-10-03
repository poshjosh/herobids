// Composition root for descriptor-driven tool visibility (Step 12 T3.2 + T4.2).
//
// Sits beside `buildAgentExternalBackendPorts`: both consume the forwarded
// EXTERNAL_BACKEND_CONFIG_JSON. This module turns the forwarded backend definition
// into a trust-policy registry, loads the backend's COMMITTED dev-signed
// descriptor from the config dir (T4.2), and rewrites a runtime descriptor's
// resolved skills so the visible tool set flows from the signed descriptor via the
// generic resolver. Trust comes from the committed public key the forwarded
// definition carries (`trustedDescriptorSigningKeys`) — there is NO runtime key
// splice.
//
// It names NO backend: the backendId comes from the forwarded definition, and the
// matcher iterates the registry. When no backend is forwarded (non-trading agent,
// or boundary unconfigured), the resolver still runs with an empty registry → every
// skill is `no_match` → unchanged (ordinary platform skills).
import { ResolvedExternalBackendSchema, type SkillDefinition } from '@herobids/domain';
import type { DescriptorTrustPolicy } from '@herobids/domain/external-backend';
import {
  applyDescriptorToolVisibility,
  type ApplyToolVisibilityResult,
  type SyncDescriptorSource,
} from './apply-tool-visibility.js';
import { createFileDescriptorSource } from './file-descriptor-source.js';

export interface DescriptorToolVisibilityLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface BuildDescriptorToolVisibilityInput {
  /** Raw EXTERNAL_BACKEND_CONFIG_JSON (same payload buildAgentExternalBackendPorts reads). */
  rawConfigJson: string | undefined;
  resolvedSkills: readonly SkillDefinition[];
  now: Date;
  logger: DescriptorToolVisibilityLogger;
}

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
  const { rawConfigJson, resolvedSkills, now, logger } = input;

  if (rawConfigJson === undefined) {
    // No backend forwarded → empty registry → every skill is no_match (unchanged).
    return applyDescriptorToolVisibility({ resolvedSkills, registry: [], descriptorSource: EMPTY_SOURCE, now });
  }

  const definition = parseTrustPolicy(rawConfigJson, logger);
  if (definition === undefined) {
    return applyDescriptorToolVisibility({ resolvedSkills, registry: [], descriptorSource: EMPTY_SOURCE, now });
  }

  // The forwarded definition already carries the committed trusted public key
  // (config `trustedDescriptorSigningKeys`), so the registry is used as-is — the
  // descriptor is loaded from its committed file and verified against that key.
  const registry: DescriptorTrustPolicy[] = [definition];
  const descriptorSource = createFileDescriptorSource({ backendId: definition.backendId, logger });

  const result = applyDescriptorToolVisibility({ resolvedSkills, registry, descriptorSource, now });
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

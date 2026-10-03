// Dev-signed STUB_DESCRIPTOR + stub descriptor source (Step 12 T3.3, P3-51).
//
// TEMPORARY. This is the local stand-in that feeds the generic trust pipeline a
// signed descriptor so trading agents resolve their tools via the generic path
// (parity) WITHOUT a real backend-published, operator-pinned descriptor. T4.2
// deletes this file; the greppable `STUB_DESCRIPTOR` / `stub-descriptor` token
// proves the deletion (I10).
//
// Signing: an EPHEMERAL in-process ed25519 keypair is generated at construction
// time. No private key is committed. The matching PUBLIC key is returned so the
// composition root can splice it into the backend's trust policy for the dev/test
// run (config carries a commented dev placeholder; the live trust is this
// in-process key). The descriptor binds the three D11 refs → the CURRENT trading
// tool schemas, sourced from the registered `AgentTool`s + `TOOL_CATALOG`, so the
// DT4 category cross-check passes by construction and the visible tool set is
// byte-identical to today's.
import { generateKeyPairSync, sign } from 'node:crypto';
import { BUILTIN_TRADING_SOURCE_REFS, type SkillDefinition } from '@herobids/domain';
import {
  canonicalizeJcs,
  type Descriptor,
  type DescriptorTool,
  type DescriptorWrapper,
} from '@herobids/domain/external-backend';
import type { SyncDescriptorSource } from './apply-tool-visibility.js';

/** The dev stub signing keyId — must match the key spliced into the trust policy. */
export const STUB_DESCRIPTOR_KEY_ID = 'traderton-stub-dev-1';

/** A tool as the registry exposes it, enough to mirror into a `DescriptorTool`. */
export interface StubToolSchemaSource {
  name: string;
  description: string;
  category: string;
  /** The tool's JSON-schema parameters (`AgentTool.parameters`). */
  parameters: Record<string, unknown>;
}

/** Looks up a registered tool's schema by name, or undefined when unregistered. */
export type StubToolSchemaLookup = (toolName: string) => StubToolSchemaSource | undefined;

export interface StubDescriptorSourceInput {
  /** The backend the stub descriptor is bound to (e.g. the first-party `tradingBackendId`). */
  backendId: string;
  /** The three built-in trading skills whose `requiredTools` the stub exposes. */
  tradingSkills: readonly SkillDefinition[];
  /** Resolves each tool name to its registered schema (name/description/category/parameters). */
  lookupToolSchema: StubToolSchemaLookup;
  /** Descriptor validity window; defaults to a wide dev window around `now`. */
  now?: Date;
}

export interface StubDescriptorSource {
  source: SyncDescriptorSource;
  /** PEM SPKI public key for the ephemeral signing key — splice into the trust policy. */
  publicKeyPem: string;
  keyId: string;
  descriptor: Descriptor;
}

function toolToDescriptorTool(schema: StubToolSchemaSource): DescriptorTool {
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: schema.parameters,
    category: schema.category,
  };
}

/** Builds the stub descriptor's sourceSkills: one D11 ref per built-in trading skill. */
function buildSourceSkills(
  tradingSkills: readonly SkillDefinition[],
  lookupToolSchema: StubToolSchemaLookup,
): Descriptor['sourceSkills'] {
  return tradingSkills.map((skill) => {
    const ref = BUILTIN_TRADING_SOURCE_REFS[skill.id];
    if (ref === undefined) {
      throw new Error(`STUB_DESCRIPTOR: skill "${skill.id}" has no D11 source ref in BUILTIN_TRADING_SOURCE_REFS`);
    }
    const tools: DescriptorTool[] = skill.requiredTools.map((toolName) => {
      const schema = lookupToolSchema(toolName);
      if (schema === undefined) {
        throw new Error(`STUB_DESCRIPTOR: tool "${toolName}" (skill "${skill.id}") is not a registered tool`);
      }
      return toolToDescriptorTool(schema);
    });
    return { ref, instructions: skill.instructions, tools };
  });
}

/**
 * Construct the dev-signed stub descriptor + a synchronous source over it. The
 * keypair is ephemeral (per process); the returned `publicKeyPem` is the only
 * trust anchor for this descriptor in the dev/test run.
 */
export function createStubDescriptorSource(input: StubDescriptorSourceInput): StubDescriptorSource {
  const { backendId, tradingSkills, lookupToolSchema } = input;
  const now = input.now ?? new Date();

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  // A wide dev validity window: issued an hour ago, expires in a decade. The stub
  // is not a lifetime-pinning exercise — the real descriptor (T4.1) owns that.
  const issuedAt = new Date(now.getTime() - 3_600_000).toISOString();
  const expiresAt = new Date(now.getTime() + 10 * 365 * 24 * 3_600_000).toISOString();

  const STUB_DESCRIPTOR: Descriptor = {
    descriptorVersion: 'stub-descriptor.1',
    backendId,
    issuedAt,
    expiresAt,
    sourceSkills: buildSourceSkills(tradingSkills, lookupToolSchema),
  };

  const signature = sign(null, Buffer.from(canonicalizeJcs(STUB_DESCRIPTOR), 'utf8'), privateKey).toString('base64');
  const wrapper: DescriptorWrapper = { descriptor: STUB_DESCRIPTOR, signature, keyId: STUB_DESCRIPTOR_KEY_ID };

  const source: SyncDescriptorSource = {
    getDescriptor: (requestedBackendId) => (requestedBackendId === backendId ? wrapper : undefined),
  };

  return { source, publicKeyPem, keyId: STUB_DESCRIPTOR_KEY_ID, descriptor: STUB_DESCRIPTOR };
}

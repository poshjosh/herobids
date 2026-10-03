// External Backend Descriptor verification (Step 10 §3; DT1/DT3/DT4; P3-3).
//
// The signed descriptor is the SOLE authority for a backend's tool schemas and
// instructions (DT4). This module owns the trust pipeline herobids runs before
// exposing any backend tool: canonicalization (RFC 8785 JCS), ed25519 signature
// verification, backendId/expiry/pin checks, source-ref approval, and the
// optional tools/list cross-check. A failure degrades the skill to
// instruction-only (DT3) — it never throws for an untrusted descriptor.
//
// Lives in the node-only external-backend subpath because verification needs
// node:crypto. Pure domain otherwise: no I/O, no transport types.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';

const JsonObjectSchema = z.record(z.unknown());

/** A backend-owned per-tool schema (ADR-015 §7). `category` is a generic capability tag. */
export const DescriptorToolSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    inputSchema: JsonObjectSchema,
    category: z.string(),
  })
  .strict();
export type DescriptorTool = z.infer<typeof DescriptorToolSchema>;

/** The descriptor as published by a backend and verified by herobids (Step 10 §3). */
export const DescriptorSchema = z
  .object({
    descriptorVersion: z.string(),
    backendId: z.string(),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    sourceSkills: z.array(
      z
        .object({ ref: z.string(), instructions: z.string(), tools: z.array(DescriptorToolSchema) })
        .strict(),
    ),
  })
  .strict();
export type Descriptor = z.infer<typeof DescriptorSchema>;

/** Transport wrapper: `signature` is base64 (padded) of the 64-byte ed25519 signature over UTF-8(JCS(descriptor)). */
export const DescriptorWrapperSchema = z
  .object({
    descriptor: DescriptorSchema,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    keyId: z.string(),
  })
  .strict();
export type DescriptorWrapper = z.infer<typeof DescriptorWrapperSchema>;

/** A backend's MCP tools/list, cross-checked against the descriptor (DT4). */
export const ToolsListSchema = z
  .object({
    tools: z.array(
      z.object({ name: z.string(), description: z.string(), inputSchema: JsonObjectSchema }).strict(),
    ),
  })
  .strict();
export type ToolsList = z.infer<typeof ToolsListSchema>;

/**
 * RFC 8785 (JCS) over the descriptor value domain (Step 10 §3, P3-3): objects,
 * arrays, strings, booleans, null and safe integers. Object keys sort by UTF-16
 * code units; primitives serialize as `JSON.stringify`. Anything else throws —
 * the value domain is closed, so a non-integer number or exotic object is a bug,
 * not an untrusted input (the wrapper is Zod-validated before it reaches here).
 */
export function canonicalizeJcs(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`JCS value domain allows safe integers only, got ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeJcs(item)).join(',')}]`;
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error('JCS value domain allows plain objects only');
    const members = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalizeJcs(member)}`);
    return `{${members.join(',')}}`;
  }
  throw new Error(`JCS value domain does not include ${typeof value}`);
}

/** Lowercase hex sha256 of UTF-8(JCS(value)) — the pin digest (Step 10 §3). */
export function sha256HexOfJcs(value: unknown): string {
  return createHash('sha256').update(Buffer.from(canonicalizeJcs(value), 'utf8')).digest('hex');
}

/**
 * ed25519 verify of `signatureBase64` over UTF-8(JCS(descriptor)) under a PEM
 * SPKI public key. Returns false (never throws) on a malformed key or signature
 * so a bad trust input degrades rather than crashes the session (DT3).
 */
export function verifyDescriptorSignature(
  descriptor: Descriptor,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    const bytes = Buffer.from(canonicalizeJcs(descriptor), 'utf8');
    return verify(null, bytes, publicKey, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

/**
 * The tools/list cross-check (Step 10 §3; DT4/D16): a backend's tools/list
 * agrees with the descriptor ⇔ its tool-name set equals the union of the
 * descriptor's sourceSkills[].tools names and, per tool, `description` is
 * string-equal and `inputSchema` is JCS-equal. Duplicate listed names disagree;
 * other Tool fields and `category` are not compared. Callers must exhaust
 * `nextCursor` pagination before calling (each page is already merged in).
 */
export function toolsListAgrees(descriptor: Descriptor, toolsList: ToolsList): boolean {
  const declared = new Map(descriptor.sourceSkills.flatMap((skill) => skill.tools).map((tool) => [tool.name, tool]));
  const listedNames = new Set(toolsList.tools.map((tool) => tool.name));
  if (listedNames.size !== toolsList.tools.length || listedNames.size !== declared.size) return false;
  return toolsList.tools.every((listed) => {
    const tool = declared.get(listed.name);
    return (
      tool !== undefined &&
      tool.description === listed.description &&
      canonicalizeJcs(tool.inputSchema) === canonicalizeJcs(listed.inputSchema)
    );
  });
}

/**
 * The trust-relevant subset of an `ExternalBackendDefinition` the pipeline reads
 * (Step 10 §1). Structural so both the config `ExternalBackendDefinition` and
 * the conformance fixtures satisfy it without a transport/caller dependency.
 */
export interface DescriptorTrustPolicy {
  backendId: string;
  enabled: boolean;
  trustedDescriptorSigningKeys: ReadonlyArray<{
    keyId: string;
    publicKey: string;
    status: 'active' | 'retiring';
  }>;
  approvedSourceSkillRefs: readonly string[];
  descriptorPinning: { mode: 'pinned'; sha256: string } | { mode: 'maxAge'; seconds: number };
}

/** Reason codes a trust failure degrades to (Step 10 §3; normative per the conformance manifest). */
export type DescriptorTrustFailureReason =
  | 'definition.disabled'
  | 'descriptor.unknown_key'
  | 'descriptor.signature_invalid'
  | 'descriptor.backend_mismatch'
  | 'descriptor.expired'
  | 'descriptor.pin_mismatch'
  | 'descriptor.ref_not_approved'
  | 'descriptor.tools_list_mismatch';

export interface ResolveDescriptorToolsInput {
  definition: DescriptorTrustPolicy;
  wrapper: DescriptorWrapper;
  /** The installed skills.sh ref whose tools this resolution scopes to (per-ref scoping). */
  installedSkillRef: string;
  now: Date;
  /** Optional MCP tools/list to cross-check (already paginated to one list). */
  toolsList?: ToolsList;
}

export type ResolveDescriptorToolsResult =
  | { outcome: 'tools_exposed'; tools: DescriptorTool[] }
  | { outcome: 'instruction_only'; reason: DescriptorTrustFailureReason };

function instructionOnly(reason: DescriptorTrustFailureReason): ResolveDescriptorToolsResult {
  return { outcome: 'instruction_only', reason };
}

/**
 * The Step 10 §3 verification pipeline. Produces the installed ref's descriptor
 * tools when every check passes, else degrades to instruction-only with the
 * failing reason (DT3). Checks run in §3 order; each conformance variant carries
 * exactly one defect, so order is a well-formedness guard, not a precedence
 * dependency.
 */
export function resolveDescriptorTools(input: ResolveDescriptorToolsInput): ResolveDescriptorToolsResult {
  const { definition, wrapper, installedSkillRef, now, toolsList } = input;
  const { descriptor } = wrapper;

  // Revocation: a disabled backend never resolves (Step 10 §4).
  if (!definition.enabled) return instructionOnly('definition.disabled');

  // Signature: keyId selects exactly one trusted key (active|retiring), no fallback.
  const signingKey = definition.trustedDescriptorSigningKeys.find((key) => key.keyId === wrapper.keyId);
  if (signingKey === undefined) return instructionOnly('descriptor.unknown_key');
  if (!verifyDescriptorSignature(descriptor, wrapper.signature, signingKey.publicKey)) {
    return instructionOnly('descriptor.signature_invalid');
  }

  // Binding + lifetime.
  if (descriptor.backendId !== definition.backendId) return instructionOnly('descriptor.backend_mismatch');
  const nowMs = now.getTime();
  const issuedAtMs = Date.parse(descriptor.issuedAt);
  const expiresAtMs = Date.parse(descriptor.expiresAt);
  // Validity is issuedAt ≤ now < expiresAt (Step 10 §3; maxAge is a cache bound, not checked here).
  if (!(issuedAtMs <= nowMs && nowMs < expiresAtMs)) return instructionOnly('descriptor.expired');

  // Pin: only `pinned` mode checks the digest; `maxAge` is a cache-age bound.
  if (definition.descriptorPinning.mode === 'pinned') {
    if (sha256HexOfJcs(descriptor) !== definition.descriptorPinning.sha256) {
      return instructionOnly('descriptor.pin_mismatch');
    }
  }

  // Approval: the installed ref must be operator-approved AND present in the descriptor.
  const approved = definition.approvedSourceSkillRefs.includes(installedSkillRef);
  const presentInDescriptor = descriptor.sourceSkills.some((skill) => skill.ref === installedSkillRef);
  if (!approved || !presentInDescriptor) return instructionOnly('descriptor.ref_not_approved');

  // tools/list cross-check (DT4) when a list is supplied.
  if (toolsList !== undefined && !toolsListAgrees(descriptor, toolsList)) {
    return instructionOnly('descriptor.tools_list_mismatch');
  }

  // Expose only the installed ref's tools (per-ref scoping).
  const tools = descriptor.sourceSkills
    .filter((skill) => skill.ref === installedSkillRef)
    .flatMap((skill) => skill.tools);
  return { outcome: 'tools_exposed', tools };
}

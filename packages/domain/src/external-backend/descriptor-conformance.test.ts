import { describe, it, expect } from 'vitest';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Descriptor conformance fixtures (Phase 3 SEAM.md §3.2; rules: Step 10 §3
 * "Canonicalization and encoding", P3-3). The directory is byte-identical to
 * traderton packages/boundary/src/__fixtures__/descriptor-conformance/, which
 * asserts the same well-formedness. The fictional `example-echo` backend is
 * generic on purpose: no trading shapes in herobids fixtures.
 *
 * Block 1 proves every variant carries exactly its declared defect. Block 2 is
 * the herobids pipeline contract, skipped until T3.1 builds the pipeline. Only
 * builtins, vitest and zod are imported, so this file moves unmodified with the
 * directory at T1.1.
 */

/** Dir digest (rule in SEAM.md §3.2). Same constant in traderton's descriptor-conformance.test.ts. */
const DESCRIPTOR_CONFORMANCE_DIR_SHA256 = '823ceb2ba634fc6df21e53e82549f3db63a8fdb19caaf52fdaf5d80d60910766';

const FIXTURE_DIR_URL = new URL('./__fixtures__/descriptor-conformance/', import.meta.url);
const DIGESTED_FILE_PATTERN = /^[a-z0-9.-]+\.json$/;

const EXPECTED_FILES = [
  'bad-signature.json',
  'expired.json',
  'manifest.json',
  'tools-list-agrees.tools-list.json',
  'tools-list-disagrees.tools-list.json',
  'tools-list-extra-tool.tools-list.json',
  'tools-list-schema-disagrees.tools-list.json',
  'unapproved-ref.json',
  'unknown-key-id.json',
  'valid.json',
  'wrong-backend-id.json',
];

const EXPECTED_VARIANT_IDS = [
  'valid',
  'valid-pinned',
  'retiring-key-accepted',
  'bad-signature',
  'wrong-backend-id',
  'expired',
  'unapproved-ref',
  'unknown-key-id',
  'pin-mismatch',
  'tools-list-agrees',
  'tools-list-disagrees',
  'tools-list-schema-disagrees',
  'tools-list-extra-tool',
  'definition-disabled',
];

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const JsonObjectSchema = z.record(z.unknown());

const DescriptorToolSchema = z
  .object({ name: z.string(), description: z.string(), inputSchema: JsonObjectSchema, category: z.string() })
  .strict();

const DescriptorSchema = z
  .object({
    descriptorVersion: z.string(),
    backendId: z.string(),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    sourceSkills: z.array(
      z.object({ ref: z.string(), instructions: z.string(), tools: z.array(DescriptorToolSchema) }).strict(),
    ),
  })
  .strict();

const DescriptorWrapperSchema = z
  .object({
    descriptor: DescriptorSchema,
    // base64 (RFC 4648 §4, padded) of a 64-byte ed25519 signature.
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    keyId: z.string(),
  })
  .strict();

const ToolsListSchema = z
  .object({
    tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: JsonObjectSchema }).strict()),
  })
  .strict();

const BackendDefinitionSchema = z
  .object({
    backendId: z.string(),
    enabled: z.boolean(),
    trustedDescriptorSigningKeys: z.array(
      z.object({ keyId: z.string(), publicKey: z.string(), status: z.enum(['active', 'retiring']) }).strict(),
    ),
    approvedSourceSkillRefs: z.array(z.string()),
    descriptorPinning: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('pinned'), sha256: Sha256HexSchema }).strict(),
      z.object({ mode: z.literal('maxAge'), seconds: z.number().int().positive() }).strict(),
    ]),
  })
  .strict();

const ExpectedSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('tools_exposed'), toolNames: z.array(z.string()) }).strict(),
  z.object({ outcome: z.literal('instruction_only'), reason: z.string() }).strict(),
]);

const VariantSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    descriptorFile: z.string(),
    toolsListFile: z.string().optional(),
    installedSkillRef: z.string(),
    definitionOverrides: BackendDefinitionSchema.partial().strict(),
    canonicalSha256: Sha256HexSchema,
    expected: ExpectedSchema,
  })
  .strict();

const ManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    description: z.string(),
    generator: z.string(),
    rules: z.record(z.string()),
    evaluationTime: z.string().datetime(),
    signingKey: z.object({ keyId: z.string(), publicKeyPem: z.string() }).strict(),
    baseDefinition: BackendDefinitionSchema,
    variants: z.array(VariantSchema),
  })
  .strict();

type Descriptor = z.infer<typeof DescriptorSchema>;
type DescriptorWrapper = z.infer<typeof DescriptorWrapperSchema>;
type ToolsList = z.infer<typeof ToolsListSchema>;
type BackendDefinition = z.infer<typeof BackendDefinitionSchema>;
type Variant = z.infer<typeof VariantSchema>;

function readFixture(name: string): Buffer {
  return readFileSync(new URL(name, FIXTURE_DIR_URL));
}

function readJson(name: string): unknown {
  return JSON.parse(readFixture(name).toString('utf8'));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The descriptor exactly as stored (file key order), for hashing without a Zod rebuild. */
function rawDescriptorOf(file: string): unknown {
  const raw = readJson(file);
  if (!isJsonObject(raw)) throw new Error(`${file} is not a JSON object`);
  return raw['descriptor'];
}

function wrapperOf(file: string): DescriptorWrapper {
  return DescriptorWrapperSchema.parse(readJson(file));
}

function toolsListOf(file: string): ToolsList {
  return ToolsListSchema.parse(readJson(file));
}

/**
 * RFC 8785 (JCS) for the descriptor value domain (Step 10 §3, P3-3): objects,
 * arrays, strings, booleans, null and safe integers. Keys sort by UTF-16 code
 * units; primitives serialize as JSON.stringify. Anything else throws.
 */
function canonicalizeJcs(value: unknown): string {
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

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function digestedFileNames(): string[] {
  return readdirSync(FIXTURE_DIR_URL, { withFileTypes: true })
    .filter((entry) => entry.isFile() && DIGESTED_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** sha256 over `name + "\n" + bytes + "\n"` per digested file, names in JS default sort order. */
function digestFixtureDir(): string {
  const hash = createHash('sha256');
  for (const name of digestedFileNames()) {
    hash.update(`${name}\n`);
    hash.update(readFixture(name));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * The `tools/list` cross-check (Step 10 §3; DT4/D16 — proposed, normative when
 * T2.2/T3.2 implement): same name set as the union of the descriptor's tools,
 * and per tool `description` string-equal and `inputSchema` JCS-equal.
 * Duplicate listed names disagree; compare after exhausting `nextCursor`
 * pagination (each fixture is one complete page); other Tool fields (title,
 * annotations, outputSchema, _meta) are not compared, nor is `category`.
 */
function toolsListAgrees(descriptor: Descriptor, toolsList: ToolsList): boolean {
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

const manifest = ManifestSchema.parse(readJson('manifest.json'));
const descriptorFiles = [...new Set(manifest.variants.map((v) => v.descriptorFile))].sort();
const toolsListFiles = [
  ...new Set(manifest.variants.flatMap((v) => (v.toolsListFile === undefined ? [] : [v.toolsListFile]))),
].sort();
const signingPublicKey = createPublicKey(manifest.signingKey.publicKeyPem);
const evaluationTimeMs = Date.parse(manifest.evaluationTime);

function variantById(id: string): Variant {
  const found = manifest.variants.find((v) => v.id === id);
  if (!found) throw new Error(`manifest is missing variant ${id}`);
  return found;
}

function verifiesUnderManifestKey(wrapper: DescriptorWrapper): boolean {
  const bytes = Buffer.from(canonicalizeJcs(wrapper.descriptor), 'utf8');
  return verify(null, bytes, signingPublicKey, Buffer.from(wrapper.signature, 'base64'));
}

function jcsEqual(a: unknown, b: unknown): boolean {
  return canonicalizeJcs(a) === canonicalizeJcs(b);
}

function trustedKeyIds(): string[] {
  return manifest.baseDefinition.trustedDescriptorSigningKeys.map((key) => key.keyId);
}

function installedTools(descriptor: Descriptor, installedSkillRef: string): string[] {
  return descriptor.sourceSkills
    .filter((skill) => skill.ref === installedSkillRef)
    .flatMap((skill) => skill.tools.map((tool) => tool.name));
}

function variantToolsList(id: string): ToolsList {
  const file = variantById(id).toolsListFile;
  if (file === undefined) throw new Error(`variant ${id} has no toolsListFile`);
  return toolsListOf(file);
}

function listedTool(toolsList: ToolsList, name: string): ToolsList['tools'][number] {
  const found = toolsList.tools.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`tools/list is missing ${name}`);
  return found;
}

function textPropertyOf(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const properties = inputSchema['properties'];
  const text = isJsonObject(properties) ? properties['text'] : undefined;
  if (!isJsonObject(text)) throw new Error('inputSchema.properties.text is not an object');
  return text;
}

function withTextPropertyDescription(inputSchema: Record<string, unknown>, description: unknown): Record<string, unknown> {
  const properties = inputSchema['properties'];
  if (!isJsonObject(properties)) throw new Error('inputSchema.properties is not an object');
  return { ...inputSchema, properties: { ...properties, text: { ...textPropertyOf(inputSchema), description } } };
}

describe('descriptor conformance fixtures are well-formed', () => {
  it('fixture dir digest equals the recorded constant', () => {
    expect(digestFixtureDir()).toBe(DESCRIPTOR_CONFORMANCE_DIR_SHA256);
  });

  it('the dir holds exactly the expected files and every manifest reference resolves', () => {
    const visibleEntries = readdirSync(FIXTURE_DIR_URL)
      .filter((name) => !name.startsWith('.'))
      .sort();
    expect(visibleEntries).toEqual(EXPECTED_FILES);
    expect(digestedFileNames()).toEqual(EXPECTED_FILES);

    const ids = manifest.variants.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...EXPECTED_VARIANT_IDS].sort());

    expect(['manifest.json', ...descriptorFiles, ...toolsListFiles].sort()).toEqual(EXPECTED_FILES);
    for (const file of descriptorFiles) {
      expect(file.endsWith('.tools-list.json')).toBe(false);
      expect(() => wrapperOf(file)).not.toThrow();
    }
    for (const file of toolsListFiles) {
      expect(file.endsWith('.tools-list.json')).toBe(true);
      expect(() => toolsListOf(file)).not.toThrow();
    }
  });

  it.each(descriptorFiles.map((file) => ({ file })))('JCS bytes of $file hash to the manifest canonicalSha256', ({ file }) => {
    const digest = sha256Hex(Buffer.from(canonicalizeJcs(rawDescriptorOf(file)), 'utf8'));
    const claimed = manifest.variants.filter((v) => v.descriptorFile === file).map((v) => v.canonicalSha256);
    expect(claimed.length).toBeGreaterThan(0);
    for (const canonicalSha256 of claimed) expect(canonicalSha256).toBe(digest);
  });

  it('valid.json stores keys out of canonical order and non-ASCII as literal UTF-8', () => {
    const raw = rawDescriptorOf('valid.json');
    const jcs = canonicalizeJcs(raw);
    // A verifier that hashed the stored key order instead of JCS would not match.
    expect(JSON.stringify(raw)).not.toBe(jcs);
    expect(jcs).toContain('—');
    expect(jcs).toContain('✓');
    expect(Buffer.byteLength(jcs, 'utf8')).toBeGreaterThan(jcs.length);
  });

  it('valid descriptor verifies with ed25519 against the manifest public key', () => {
    const pem = manifest.signingKey.publicKeyPem;
    expect(pem.startsWith('-----BEGIN PUBLIC KEY-----\n')).toBe(true);
    expect(signingPublicKey.asymmetricKeyType).toBe('ed25519');
    expect(signingPublicKey.export({ type: 'spki', format: 'pem' })).toBe(pem);
    expect(manifest.baseDefinition.trustedDescriptorSigningKeys).toEqual([
      { keyId: manifest.signingKey.keyId, publicKey: pem, status: 'active' },
    ]);

    const valid = wrapperOf('valid.json');
    expect(valid.keyId).toBe(manifest.signingKey.keyId);
    expect(Buffer.from(valid.signature, 'base64')).toHaveLength(64);
    expect(verifiesUnderManifestKey(valid)).toBe(true);

    // valid has no defect of its own.
    expect(valid.descriptor.backendId).toBe(manifest.baseDefinition.backendId);
    expect(Date.parse(valid.descriptor.issuedAt)).toBeLessThanOrEqual(evaluationTimeMs);
    expect(Date.parse(valid.descriptor.expiresAt)).toBeGreaterThan(evaluationTimeMs);
    for (const skill of valid.descriptor.sourceSkills) {
      expect(manifest.baseDefinition.approvedSourceSkillRefs).toContain(skill.ref);
    }
    expect(manifest.baseDefinition.enabled).toBe(true);
    expect(manifest.baseDefinition.descriptorPinning.mode).toBe('maxAge');
  });

  it('every non-expired descriptor has issuedAt ≤ evaluationTime and an age within maxAge seconds', () => {
    const pinning = manifest.baseDefinition.descriptorPinning;
    if (pinning.mode !== 'maxAge') throw new Error('baseDefinition must use maxAge pinning');
    const nonExpiredFiles = descriptorFiles.filter(
      (file) => Date.parse(wrapperOf(file).descriptor.expiresAt) > evaluationTimeMs,
    );
    expect(nonExpiredFiles).toEqual(descriptorFiles.filter((file) => file !== variantById('expired').descriptorFile));
    for (const file of nonExpiredFiles) {
      const ageMs = evaluationTimeMs - Date.parse(wrapperOf(file).descriptor.issuedAt);
      expect(ageMs).toBeGreaterThanOrEqual(0);
      // maxAge bounds cache age, not issuedAt age (Step 10 §3); the data satisfy both readings.
      expect(ageMs).toBeLessThanOrEqual(pinning.seconds * 1000);
    }
  });

  it('tools_exposed expectations name exactly the descriptor tools of the installed ref', () => {
    for (const variant of manifest.variants) {
      if (variant.expected.outcome !== 'tools_exposed') continue;
      const descriptor = wrapperOf(variant.descriptorFile).descriptor;
      expect(variant.expected.toolNames).toEqual(installedTools(descriptor, variant.installedSkillRef));
    }
  });

  it('each variant overrides only its declared definition keys', () => {
    const overriddenKeys = Object.fromEntries(
      manifest.variants.map((v) => [v.id, Object.keys(v.definitionOverrides).sort()]),
    );
    expect(overriddenKeys).toEqual({
      valid: [],
      'valid-pinned': ['descriptorPinning'],
      'retiring-key-accepted': ['trustedDescriptorSigningKeys'],
      'bad-signature': [],
      'wrong-backend-id': [],
      expired: [],
      'unapproved-ref': [],
      'unknown-key-id': [],
      'pin-mismatch': ['descriptorPinning'],
      'tools-list-agrees': [],
      'tools-list-disagrees': [],
      'tools-list-schema-disagrees': [],
      'tools-list-extra-tool': [],
      'definition-disabled': ['enabled'],
    });
    for (const variant of manifest.variants) {
      const keyIds = (
        variant.definitionOverrides.trustedDescriptorSigningKeys ?? manifest.baseDefinition.trustedDescriptorSigningKeys
      ).map((key) => key.keyId);
      expect(new Set(keyIds).size).toBe(keyIds.length);
      if (variant.id === 'unapproved-ref') continue;
      expect(manifest.baseDefinition.approvedSourceSkillRefs).toContain(variant.installedSkillRef);
    }
  });

  describe('each tampered variant carries exactly its declared defect', () => {
    const valid = wrapperOf('valid.json');

    it('bad-signature: valid descriptor and keyId, signature byte 0 XOR 0x01, fails verification', () => {
      const tampered = wrapperOf(variantById('bad-signature').descriptorFile);
      expect(jcsEqual(tampered.descriptor, valid.descriptor)).toBe(true);
      expect(tampered.keyId).toBe(valid.keyId);

      const original = Buffer.from(valid.signature, 'base64');
      const flipped = Buffer.from(tampered.signature, 'base64');
      expect(flipped).toHaveLength(original.length);
      const xor = Array.from(original, (byte, i) => byte ^ flipped.readUInt8(i));
      expect(xor).toEqual([0x01, ...new Array<number>(original.length - 1).fill(0)]);

      expect(verifiesUnderManifestKey(tampered)).toBe(false);
    });

    it('unknown-key-id: valid descriptor and signature, keyId names no trusted key', () => {
      const tampered = wrapperOf(variantById('unknown-key-id').descriptorFile);
      expect(jcsEqual(tampered.descriptor, valid.descriptor)).toBe(true);
      expect(tampered.signature).toBe(valid.signature);
      expect(trustedKeyIds()).not.toContain(tampered.keyId);
      expect(verifiesUnderManifestKey(tampered)).toBe(true);
    });

    it('wrong-backend-id: validly signed, only backendId differs', () => {
      const tampered = wrapperOf(variantById('wrong-backend-id').descriptorFile);
      expect(tampered.keyId).toBe(valid.keyId);
      expect(verifiesUnderManifestKey(tampered)).toBe(true);
      expect(tampered.descriptor.backendId).not.toBe(manifest.baseDefinition.backendId);
      expect(jcsEqual({ ...tampered.descriptor, backendId: valid.descriptor.backendId }, valid.descriptor)).toBe(true);
    });

    it('expired: validly signed, only expiresAt differs, issuedAt < expiresAt < evaluationTime', () => {
      const tampered = wrapperOf(variantById('expired').descriptorFile);
      expect(tampered.keyId).toBe(valid.keyId);
      expect(verifiesUnderManifestKey(tampered)).toBe(true);
      expect(Date.parse(tampered.descriptor.issuedAt)).toBeLessThan(Date.parse(tampered.descriptor.expiresAt));
      expect(Date.parse(tampered.descriptor.expiresAt)).toBeLessThan(evaluationTimeMs);
      expect(jcsEqual({ ...tampered.descriptor, expiresAt: valid.descriptor.expiresAt }, valid.descriptor)).toBe(true);
    });

    it('unapproved-ref: validly signed, one sourceSkill ref replaced by the unapproved installed ref', () => {
      const variant = variantById('unapproved-ref');
      const tampered = wrapperOf(variant.descriptorFile);
      expect(tampered.keyId).toBe(valid.keyId);
      expect(verifiesUnderManifestKey(tampered)).toBe(true);

      const approved = manifest.baseDefinition.approvedSourceSkillRefs;
      const unapproved = tampered.descriptor.sourceSkills.map((s) => s.ref).filter((ref) => !approved.includes(ref));
      expect(unapproved).toEqual([variant.installedSkillRef]);
      // The unapproved ref carries real tools, so skipping the approval check would expose them.
      expect(installedTools(tampered.descriptor, variant.installedSkillRef).length).toBeGreaterThan(0);

      const tamperedRefs = new Set(tampered.descriptor.sourceSkills.map((s) => s.ref));
      const replaced = valid.descriptor.sourceSkills.map((s) => s.ref).filter((ref) => !tamperedRefs.has(ref));
      expect(replaced).toHaveLength(1);
      const [replacedRef] = replaced;
      if (replacedRef === undefined) throw new Error('no valid ref was replaced');
      const restored: Descriptor = {
        ...tampered.descriptor,
        sourceSkills: tampered.descriptor.sourceSkills.map((s) =>
          s.ref === variant.installedSkillRef ? { ...s, ref: replacedRef } : s,
        ),
      };
      expect(jcsEqual(restored, valid.descriptor)).toBe(true);
    });

    it('pin-mismatch: pinned to a real digest of a different descriptor; valid-pinned to the valid digest', () => {
      const validSha256 = variantById('valid').canonicalSha256;
      const pinnedTo = (id: string): string | undefined => {
        const pinning = variantById(id).definitionOverrides.descriptorPinning;
        return pinning?.mode === 'pinned' ? pinning.sha256 : undefined;
      };

      expect(variantById('pin-mismatch').descriptorFile).toBe('valid.json');
      expect(pinnedTo('pin-mismatch')).toBe(variantById('wrong-backend-id').canonicalSha256);
      expect(pinnedTo('pin-mismatch')).not.toBe(validSha256);

      expect(variantById('valid-pinned').descriptorFile).toBe('valid.json');
      expect(pinnedTo('valid-pinned')).toBe(validSha256);
    });

    it('retiring-key-accepted: the same key with status retiring; definition-disabled: enabled false', () => {
      expect(variantById('retiring-key-accepted').definitionOverrides.trustedDescriptorSigningKeys).toEqual([
        { keyId: manifest.signingKey.keyId, publicKey: manifest.signingKey.publicKeyPem, status: 'retiring' },
      ]);
      expect(variantById('definition-disabled').definitionOverrides).toEqual({ enabled: false });
    });

    it('tools-list-agrees matches the descriptor under the cross-check rule; tools-list-disagrees does not', () => {
      for (const variant of manifest.variants) {
        if (variant.toolsListFile !== undefined) expect(variant.descriptorFile).toBe('valid.json');
      }
      const agrees = variantToolsList('tools-list-agrees');
      const disagrees = variantToolsList('tools-list-disagrees');

      expect(toolsListAgrees(valid.descriptor, agrees)).toBe(true);
      expect(toolsListAgrees(valid.descriptor, disagrees)).toBe(false);
      // Agreement is name-set and JCS equality, not byte equality: per tool, the
      // listed inputSchema differs in key order from the declared one.
      for (const declared of valid.descriptor.sourceSkills.flatMap((s) => s.tools)) {
        const listed = listedTool(agrees, declared.name);
        expect(JSON.stringify(listed.inputSchema)).not.toBe(JSON.stringify(declared.inputSchema));
        expect(jcsEqual(listed.inputSchema, declared.inputSchema)).toBe(true);
      }

      // The only defect: echo_text's description.
      const restored: ToolsList = {
        tools: disagrees.tools.map((tool) => {
          const original = agrees.tools.find((t) => t.name === tool.name);
          return tool.name === 'echo_text' && original ? { ...tool, description: original.description } : tool;
        }),
      };
      expect(jcsEqual(restored, agrees)).toBe(true);
      expect(jcsEqual(disagrees, agrees)).toBe(false);
    });

    it('tools-list-schema-disagrees: only echo_text.inputSchema.properties.text.description differs', () => {
      const agrees = variantToolsList('tools-list-agrees');
      const tampered = variantToolsList('tools-list-schema-disagrees');
      expect(toolsListAgrees(valid.descriptor, tampered)).toBe(false);

      const originalDescription = textPropertyOf(listedTool(agrees, 'echo_text').inputSchema)['description'];
      expect(textPropertyOf(listedTool(tampered, 'echo_text').inputSchema)['description']).not.toBe(originalDescription);
      const restored: ToolsList = {
        tools: tampered.tools.map((tool) =>
          tool.name === 'echo_text'
            ? { ...tool, inputSchema: withTextPropertyDescription(tool.inputSchema, originalDescription) }
            : tool,
        ),
      };
      expect(jcsEqual(restored, agrees)).toBe(true);
    });

    it('tools-list-extra-tool: the agreeing list plus exactly one tool the descriptor does not declare', () => {
      const agrees = variantToolsList('tools-list-agrees');
      const tampered = variantToolsList('tools-list-extra-tool');
      expect(toolsListAgrees(valid.descriptor, tampered)).toBe(false);

      const declaredNames = new Set(valid.descriptor.sourceSkills.flatMap((s) => s.tools.map((t) => t.name)));
      expect(tampered.tools.filter((tool) => !declaredNames.has(tool.name))).toHaveLength(1);
      const restored: ToolsList = { tools: tampered.tools.filter((tool) => declaredNames.has(tool.name)) };
      expect(jcsEqual(restored, agrees)).toBe(true);
    });
  });
});

// ── Pipeline contract: assertions written now, green at T3.1 ────────────────

/** The shape the T3.1 pipeline is expected to satisfy (adapt this mapping if its signature differs). */
type ResolveDescriptorTools = (input: {
  definition: BackendDefinition;
  wrapper: DescriptorWrapper;
  installedSkillRef: string;
  now: Date;
  toolsList?: ToolsList;
}) => { outcome: 'tools_exposed'; tools: Array<{ name: string }> } | { outcome: 'instruction_only'; reason: string };

const resolveDescriptorTools: ResolveDescriptorTools = () => {
  throw new Error('TODO(T3.1): import the real pipeline');
};

describe.skip('descriptor conformance pipeline — TODO(T3.1) flip to describe', () => {
  it.each(manifest.variants)('$id → $expected.outcome', (variant) => {
    const toolsList = variant.toolsListFile === undefined ? undefined : toolsListOf(variant.toolsListFile);
    const result = resolveDescriptorTools({
      definition: { ...manifest.baseDefinition, ...variant.definitionOverrides },
      wrapper: wrapperOf(variant.descriptorFile),
      installedSkillRef: variant.installedSkillRef,
      now: new Date(manifest.evaluationTime),
      ...(toolsList === undefined ? {} : { toolsList }),
    });
    const observed =
      result.outcome === 'tools_exposed'
        ? { outcome: result.outcome, toolNames: result.tools.map((tool) => tool.name) }
        : { outcome: result.outcome, reason: result.reason };
    // `outcome` and `reason` are both normative: T3.1 adopts these reason codes as-is.
    expect(observed).toEqual(variant.expected);
  });
});

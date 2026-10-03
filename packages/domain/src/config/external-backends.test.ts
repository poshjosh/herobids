import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  ExternalBackendDefinitionSchema,
  ExternalBackendRegistrySchema,
  ResolvedExternalBackendSchema,
  findExternalBackend,
  findExternalBackendProtocolViolations,
  resolveExternalBackend,
  type ExternalBackendDefinition,
} from './external-backends.js';

const PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAfMgtobz4ygRWlnYmiNmxW7tq/jhSITxV8Q3EkH3rw80=\n-----END PUBLIC KEY-----\n';

/** Minimal valid YAML-side entry (everything defaultable omitted). */
function minimalEntry(): Record<string, unknown> {
  return {
    endpoint: { baseUrl: 'http://localhost:8080' },
    caller: { consumerId: 'herobids', keyId: 'current', hmacSecretRef: 'EXAMPLE_HMAC_SECRET' },
    descriptorPinning: { mode: 'maxAge', seconds: 3600 },
  };
}

function minimalDefinitionInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { backendId: 'example-echo', ...minimalEntry(), ...overrides };
}

function endpointWith(fields: Record<string, unknown>): Record<string, unknown> {
  return { endpoint: { baseUrl: 'http://localhost:8080', ...fields } };
}

function parseDefinition(overrides: Record<string, unknown> = {}): ExternalBackendDefinition {
  return ExternalBackendDefinitionSchema.parse(minimalDefinitionInput(overrides));
}

function issuePaths(input: Record<string, unknown>): string[] {
  const result = ExternalBackendDefinitionSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.'));
}

describe('ExternalBackendDefinitionSchema', () => {
  it('applies defaults: enabled, contractVersion 1.0, protocol rest, health.readyPath, empty trust lists', () => {
    const definition = parseDefinition();
    expect(definition.enabled).toBe(true);
    expect(definition.endpoint.contractVersion).toBe('1.0');
    expect(definition.endpoint.protocol).toBe('rest');
    expect(definition.endpoint.requestTimeoutMs).toBe(10_000);
    expect(definition.endpoint.toolProtocolOverrides).toBeUndefined();
    expect(definition.endpoint.mcpPath).toBeUndefined();
    expect(definition.health.readyPath).toBe('/health/ready');
    expect(definition.trustedDescriptorSigningKeys).toEqual([]);
    expect(definition.approvedSourceSkillRefs).toEqual([]);
  });

  it('rejects an unknown protocol', () => {
    expect(issuePaths(minimalDefinitionInput(endpointWith({ protocol: 'grpc' })))).toContain('endpoint.protocol');
  });

  it('rejects an unknown protocol in toolProtocolOverrides', () => {
    const input = minimalDefinitionInput(endpointWith({ toolProtocolOverrides: { echo_text: 'grpc' } }));
    expect(issuePaths(input)).toContain('endpoint.toolProtocolOverrides.echo_text');
  });

  it('rejects a toolProtocolOverrides key that is not a snake_case tool name', () => {
    const input = minimalDefinitionInput(endpointWith({ toolProtocolOverrides: { 'Echo-Text': 'rest' } }));
    expect(ExternalBackendDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it('requires mcpPath when the protocol or any tool override is mcp', () => {
    expect(issuePaths(minimalDefinitionInput(endpointWith({ protocol: 'mcp' })))).toEqual(['endpoint.mcpPath']);
    expect(
      issuePaths(minimalDefinitionInput(endpointWith({ toolProtocolOverrides: { echo_text: 'mcp' } }))),
    ).toEqual(['endpoint.mcpPath']);
    expect(issuePaths(minimalDefinitionInput(endpointWith({ protocol: 'mcp', mcpPath: '/mcp' })))).toEqual([]);
    expect(
      issuePaths(minimalDefinitionInput(endpointWith({ toolProtocolOverrides: { echo_text: 'rest' } }))),
    ).toEqual([]);
  });

  it('rejects an mcpPath that is not an absolute path without query or fragment', () => {
    for (const mcpPath of ['mcp', '/mcp?x=1', '/mcp#frag']) {
      expect(issuePaths(minimalDefinitionInput(endpointWith({ protocol: 'mcp', mcpPath })))).toContain(
        'endpoint.mcpPath',
      );
    }
  });

  it('rejects a requestTimeoutMs below 1000', () => {
    expect(issuePaths(minimalDefinitionInput(endpointWith({ requestTimeoutMs: 999 })))).toContain(
      'endpoint.requestTimeoutMs',
    );
  });

  it('rejects an hmacSecretRef that is not an environment variable name', () => {
    for (const hmacSecretRef of ['s3cr3t-value', 'lower_case', '1LEADING_DIGIT', '']) {
      const input = minimalDefinitionInput({ caller: { consumerId: 'herobids', keyId: 'current', hmacSecretRef } });
      expect(issuePaths(input)).toContain('caller.hmacSecretRef');
    }
  });

  it('rejects duplicate descriptor signing keyIds', () => {
    const input = minimalDefinitionInput({
      trustedDescriptorSigningKeys: [
        { keyId: 'dev-1', publicKey: PEM, status: 'active' },
        { keyId: 'dev-1', publicKey: PEM, status: 'retiring' },
      ],
    });
    expect(issuePaths(input)).toEqual(['trustedDescriptorSigningKeys.1.keyId']);
  });

  it('rejects a descriptor signing key that is not PEM SPKI', () => {
    const input = minimalDefinitionInput({
      trustedDescriptorSigningKeys: [{ keyId: 'dev-1', publicKey: 'MCowBQYDK2VwAyEA', status: 'active' }],
    });
    expect(issuePaths(input)).toContain('trustedDescriptorSigningKeys.0.publicKey');
  });

  it('rejects a malformed approved skill ref', () => {
    for (const ref of ['example/echo', 'example/skills/echo/extra', 'example skills/echo/x']) {
      expect(issuePaths(minimalDefinitionInput({ approvedSourceSkillRefs: [ref] }))).toContain(
        'approvedSourceSkillRefs.0',
      );
    }
  });

  it('rejects duplicate approved skill refs', () => {
    const input = minimalDefinitionInput({ approvedSourceSkillRefs: ['example/skills/echo', 'example/skills/echo'] });
    expect(issuePaths(input)).toEqual(['approvedSourceSkillRefs.1']);
  });

  it('pinned descriptorPinning requires a 64-hex sha256', () => {
    const digest = 'a'.repeat(64);
    expect(issuePaths(minimalDefinitionInput({ descriptorPinning: { mode: 'pinned', sha256: digest } }))).toEqual([]);
    for (const sha256 of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
      expect(issuePaths(minimalDefinitionInput({ descriptorPinning: { mode: 'pinned', sha256 } }))).toContain(
        'descriptorPinning.sha256',
      );
    }
    expect(issuePaths(minimalDefinitionInput({ descriptorPinning: { mode: 'pinned' } }))).toContain(
      'descriptorPinning.sha256',
    );
  });

  it('requires descriptorPinning', () => {
    const { descriptorPinning: _omitted, ...input } = minimalDefinitionInput();
    expect(issuePaths(input)).toContain('descriptorPinning');
  });

  it('accepts http(s) base URLs including docker-internal hostnames', () => {
    for (const baseUrl of ['http://localhost:8080', 'http://host.docker.internal:8080', 'https://api.example.test']) {
      expect(issuePaths(minimalDefinitionInput({ endpoint: { baseUrl } }))).toEqual([]);
    }
  });

  it('rejects a base URL without an http(s) scheme or with credentials', () => {
    for (const baseUrl of ['localhost:8080', 'ftp://example.test', 'file:///etc/passwd', 'http://user:pw@example.test']) {
      expect(issuePaths(minimalDefinitionInput({ endpoint: { baseUrl } }))).toContain('endpoint.baseUrl');
    }
  });

  it('rejects a requestTimeoutMs above the timer limit', () => {
    expect(issuePaths(minimalDefinitionInput(endpointWith({ requestTimeoutMs: 2 ** 31 })))).toContain(
      'endpoint.requestTimeoutMs',
    );
  });

  it('rejects a skill ref with a dot or dot-dot segment', () => {
    for (const ref of ['../skills/echo', 'example/./echo', 'example/skills/..']) {
      expect(issuePaths(minimalDefinitionInput({ approvedSourceSkillRefs: [ref] }))).toContain(
        'approvedSourceSkillRefs.0',
      );
    }
    expect(issuePaths(minimalDefinitionInput({ approvedSourceSkillRefs: ['example/skills/.echo'] }))).toEqual([]);
  });

  it('rejects an unknown key at any level so a misspelt field cannot fail open', () => {
    expect(ExternalBackendDefinitionSchema.safeParse(minimalDefinitionInput({ enable: false })).success).toBe(false);
    expect(
      ExternalBackendDefinitionSchema.safeParse(minimalDefinitionInput(endpointWith({ protocl: 'mcp' }))).success,
    ).toBe(false);
    expect(
      ExternalBackendDefinitionSchema.safeParse(
        minimalDefinitionInput({ descriptorPinning: { mode: 'maxAge', seconds: 60, sha256: 'a'.repeat(64) } }),
      ).success,
    ).toBe(false);
  });
});

describe('ExternalBackendRegistrySchema', () => {
  it('parses a registry map into definitions carrying their backendId', () => {
    const registry = ExternalBackendRegistrySchema.parse({
      'example-echo': minimalEntry(),
      'other-backend': { ...minimalEntry(), enabled: false },
    });
    expect(registry.map((definition) => [definition.backendId, definition.enabled])).toEqual([
      ['example-echo', true],
      ['other-backend', false],
    ]);
    expect(registry[0]).toEqual(parseDefinition());
  });

  it('defaults to an empty registry', () => {
    expect(ExternalBackendRegistrySchema.parse(undefined)).toEqual([]);
  });

  it('rejects an invalid backendId key', () => {
    for (const backendId of ['Example', 'example_echo', '-leading']) {
      expect(ExternalBackendRegistrySchema.safeParse({ [backendId]: minimalEntry() }).success).toBe(false);
    }
  });

  it('applies entry refinements to registry entries', () => {
    const result = ExternalBackendRegistrySchema.safeParse({
      'example-echo': { ...minimalEntry(), ...endpointWith({ protocol: 'mcp' }) },
    });
    expect(result.success).toBe(false);
  });
});

const ConformanceManifestSchema = z.object({
  baseDefinition: z.record(z.unknown()),
  variants: z.array(z.object({ id: z.string(), definitionOverrides: z.record(z.unknown()) })).min(1),
});

describe('T0.4 descriptor conformance manifest', () => {
  // Filesystem read, not an import: config/ never depends on the client subpath.
  const manifest = ConformanceManifestSchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../external-backend/__fixtures__/descriptor-conformance/manifest.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  // The trust-field projection the fixtures carry (no endpoint/caller/health).
  const TrustFieldsSchema = ExternalBackendDefinitionSchema.innerType()
    .pick({
      backendId: true,
      enabled: true,
      trustedDescriptorSigningKeys: true,
      approvedSourceSkillRefs: true,
      descriptorPinning: true,
    })
    .strict();

  it('accepts the T0.4 conformance manifest baseDefinition and every variant override as trust fields', () => {
    for (const variant of manifest.variants) {
      // Manifest rule: definitionOverrides shallow-replace top-level baseDefinition keys.
      const trustFields = { ...manifest.baseDefinition, ...variant.definitionOverrides };
      expect(TrustFieldsSchema.safeParse(trustFields).success, variant.id).toBe(true);
      // The full schema (incl. keyId/skill-ref uniqueness refinements) accepts them too.
      const full = ExternalBackendDefinitionSchema.safeParse({ ...minimalEntry(), ...trustFields });
      expect(full.success ? [] : full.error.issues, variant.id).toEqual([]);
    }
  });
});

describe('findExternalBackend', () => {
  const registry = [parseDefinition()];

  it('finds a definition by backendId and returns undefined otherwise', () => {
    expect(findExternalBackend(registry, 'example-echo')?.backendId).toBe('example-echo');
    expect(findExternalBackend(registry, 'missing')).toBeUndefined();
    expect(findExternalBackend(registry, undefined)).toBeUndefined();
  });
});

describe('resolveExternalBackend', () => {
  const registry = [
    parseDefinition(),
    parseDefinition({ backendId: 'disabled-backend', enabled: false }),
  ];

  it('returns the definition and the secret read from the referenced env var', () => {
    const result = resolveExternalBackend(registry, 'example-echo', { EXAMPLE_HMAC_SECRET: 'test-secret' });
    expect(result).toEqual({ ok: true, data: { definition: registry[0], hmacSecret: 'test-secret' } });
  });

  it('round-trips a resolved backend through JSON as the worker-to-agent payload', () => {
    const resolved = resolveExternalBackend(registry, 'example-echo', { EXAMPLE_HMAC_SECRET: 'test-secret' });
    if (!resolved.ok) throw new Error('expected a resolved backend');
    const reparsed = ResolvedExternalBackendSchema.parse(JSON.parse(JSON.stringify(resolved.data)));
    expect(reparsed).toEqual(resolved.data);
  });

  it('reports not_selected when no backendId is given', () => {
    const result = resolveExternalBackend(registry, undefined, { EXAMPLE_HMAC_SECRET: 'test-secret' });
    expect(result.ok ? undefined : result.error.code).toBe('external_backend.not_selected');
  });

  it('reports not_registered for an unknown backendId', () => {
    const result = resolveExternalBackend(registry, 'missing', { EXAMPLE_HMAC_SECRET: 'test-secret' });
    expect(result.ok ? undefined : result.error.code).toBe('external_backend.not_registered');
  });

  it('reports disabled for a disabled definition', () => {
    const result = resolveExternalBackend(registry, 'disabled-backend', { EXAMPLE_HMAC_SECRET: 'test-secret' });
    expect(result.ok ? undefined : result.error.code).toBe('external_backend.disabled');
  });

  it.each([
    ['unset', {}],
    ['empty', { EXAMPLE_HMAC_SECRET: '' }],
  ])('reports secret_missing when the referenced env var is %s', (_label, env) => {
    const result = resolveExternalBackend(registry, 'example-echo', env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('external_backend.secret_missing');
    expect(result.error.context).toEqual({ backendId: 'example-echo', hmacSecretRef: 'EXAMPLE_HMAC_SECRET' });
  });
});

describe('findExternalBackendProtocolViolations', () => {
  const restDefinition = parseDefinition({ backendId: 'rest-backend' });
  const mcpDefinition = parseDefinition({ backendId: 'mcp-backend', ...endpointWith({ protocol: 'mcp', mcpPath: '/mcp' }) });
  const overrideDefinition = parseDefinition({
    backendId: 'override-backend',
    ...endpointWith({ toolProtocolOverrides: { echo_text: 'mcp', reverse_text: 'rest' }, mcpPath: '/mcp' }),
  });
  const registry = [restDefinition, mcpDefinition, overrideDefinition];

  it('flags mcp in staging and production, allows it in development and test, never flags rest', () => {
    for (const environment of ['staging', 'production']) {
      const violations = findExternalBackendProtocolViolations(registry, environment);
      expect(violations).toHaveLength(2);
      expect(violations[0]).toContain('externalBackends.mcp-backend.endpoint.protocol');
      expect(violations[1]).toContain('externalBackends.override-backend.endpoint.toolProtocolOverrides.echo_text');
      expect(violations.join('\n')).not.toContain('rest-backend');
    }
    for (const environment of ['development', 'test']) {
      expect(findExternalBackendProtocolViolations(registry, environment)).toEqual([]);
    }
    expect(findExternalBackendProtocolViolations([restDefinition], 'production')).toEqual([]);
  });
});

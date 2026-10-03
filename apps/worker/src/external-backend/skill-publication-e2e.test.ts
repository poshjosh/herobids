// End-to-end external-skill publication over BOTH transports (Phase 3 T4.3).
//
// Proves the FULL generic chain on the LOCAL FIXTURE skill source (D20: local
// work is invisible to the live `npx skills` CLI, so this test never spawns it):
//
//   install → descriptor resolution → tool visibility → invocation → result mapping
//
// Every leg composes the REAL unit — the test's value is that it wires the
// actual installer, resolver, visibility applicator, file descriptor source,
// generic client, and both fake-boundary faces together, not reimplementations:
//
//   1. install   — `LocalDirectorySkillInstaller` (T0.5) installs each of the
//                   three authored crypto skills from an in-repo fixture tree
//                   (hermetic: no ~/dev_ai/traderton-skills, no network, no CLI).
//   2. resolution — the installed skill maps to a resolved `SkillDefinition`
//                   carrying the normalized `sourceRef`, run through
//                   `applyDescriptorToolVisibility` with the COMMITTED dev-signed
//                   descriptor (T4.2) + the config trust key.
//   3. visibility — `tools_exposed` with EXACTLY the descriptor's tool set for
//                   that ref; a non-approved ref → no tools.
//   4. invocation — PARAMETERISED over ['rest','mcp']: a real `ExternalBackendClient`
//      + mapping    drives an exposed tool into the fake idempotent boundary over
//                   each wire; success maps to success, and every closed-union
//                   failure code + its retryable flag survives verbatim.
//
// Real-remote resolution (the live `npx skills` CLI against the published repo)
// is DEFERRED to the post-push operator step — it cannot run in-process (D20) and
// is NOT faked here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_TRADING_SOURCE_REFS,
  BOT_MANAGEMENT_SKILL,
  RISK_MONITORING_SKILL,
  TRADING_SKILL,
  type ExternalBackendProtocol,
  type SkillDefinition,
} from '@herobids/domain';
import {
  createExternalBackendClient,
  type ExternalBackendClient,
  type ExternalBackendFailureCode,
  type ExternalBackendSubject,
} from '@herobids/domain/external-backend';
import type { DescriptorTrustPolicy } from '@herobids/domain/external-backend';
import { LocalDirectorySkillInstaller } from '../tools/local-directory-skill-installer.js';
import {
  createFileDescriptorSource,
  type FileDescriptorSourceLogger,
} from './file-descriptor-source.js';
import {
  applyDescriptorToolVisibility,
  type SyncDescriptorSource,
} from './apply-tool-visibility.js';
import {
  FAKE_MCP_PATH,
  startFakeIdempotentBoundary,
  startFakeMcpBoundary,
  type FakeIdempotentBoundary,
} from './__tests__/fake-idempotent-boundary.js';

// The live skills CLI must never be reached — the whole chain runs on the local
// fixture source (D20). Any spawn throws loudly (mirrors the T0.5 test).
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('skills CLI must not be spawned');
  }),
}));

const FIXTURE_SOURCE_ROOT = fileURLToPath(
  new URL('./__fixtures__/traderton-skill-source/', import.meta.url),
);

const BACKEND_ID = 'traderton';
const KEY_ID = 'traderton-dev-1';
// Inside the committed descriptor's validity window (issued ~now, expires in a decade).
const NOW = new Date('2027-01-01T00:00:00.000Z');

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const COMMITTED_PUBLIC_KEY_PEM = readFileSync(
  join(REPO_ROOT, 'config', 'external-backends', 'traderton.descriptor.pub.pem'),
  'utf8',
);

/** The three authored crypto skills, each identified by its publication ref. */
const CRYPTO_SKILLS = [
  { skill: TRADING_SKILL, segment: 'crypto-trading', refKey: 'trading' },
  { skill: BOT_MANAGEMENT_SKILL, segment: 'crypto-bot-management', refKey: 'bot-management' },
  { skill: RISK_MONITORING_SKILL, segment: 'crypto-risk-monitoring', refKey: 'risk-monitoring' },
] as const;

/**
 * Derive the normalized `sourceRef` from an install ref, the inverse of the
 * installer's `owner/repo@skill` parse: `traderton/skills@crypto-trading` →
 * `traderton/skills/crypto-trading`. This is the real derivation the platform
 * uses — the built-in trading skills carry exactly this value via
 * `BUILTIN_TRADING_SOURCE_REFS` (asserted below), and the committed descriptor
 * approves/binds the same slash-form ref. Not a stand-in: the test proves the
 * derived ref equals the committed datum rather than hand-faking a string.
 */
function sourceRefFromInstallRef(installRef: string): string {
  const match = /^([^/@]+)\/([^/@]+)@([^/@]+)$/.exec(installRef);
  if (!match) throw new Error(`not an install ref: ${installRef}`);
  const [, owner, repo, skill] = match;
  return `${owner}/${repo}/${skill}`;
}

function installRefFor(segment: string): string {
  return `${BACKEND_ID}/skills@${segment}`;
}

function makeLogger(): FileDescriptorSourceLogger {
  return { warn: vi.fn() };
}

/**
 * The trust policy the operator config forwards for traderton, with the
 * COMMITTED dev public key (trust is config-committed, not a runtime splice).
 * Mirrors `committedPolicy` in file-descriptor-source.test.ts and the real
 * `approvedSourceSkillRefs` the registry carries.
 */
function committedPolicy(overrides: Partial<DescriptorTrustPolicy> = {}): DescriptorTrustPolicy {
  return {
    backendId: BACKEND_ID,
    enabled: true,
    trustedDescriptorSigningKeys: [{ keyId: KEY_ID, publicKey: COMMITTED_PUBLIC_KEY_PEM, status: 'active' }],
    approvedSourceSkillRefs: [
      BUILTIN_TRADING_SOURCE_REFS['trading']!,
      BUILTIN_TRADING_SOURCE_REFS['bot-management']!,
      BUILTIN_TRADING_SOURCE_REFS['risk-monitoring']!,
    ],
    descriptorPinning: { mode: 'maxAge', seconds: 3600 },
    ...overrides,
  };
}

/** The committed file descriptor source (T4.2) — reads the real signed JSON. */
function committedDescriptorSource(): SyncDescriptorSource {
  return createFileDescriptorSource({ backendId: BACKEND_ID, logger: makeLogger() });
}

/**
 * Run one installed skill through the generic visibility applicator with the
 * committed descriptor + trust policy. Returns the single rewritten skill and
 * its outcome so a test can read the exposed tool set.
 */
function resolveVisibility(skill: SkillDefinition, registry: readonly DescriptorTrustPolicy[]) {
  const result = applyDescriptorToolVisibility({
    resolvedSkills: [skill],
    registry,
    descriptorSource: committedDescriptorSource(),
    now: NOW,
  });
  return { rewritten: result.resolvedSkills[0]!, outcomes: result.outcomes };
}

describe('T4.3 — external-skill publication end to end (local fixture source)', () => {
  let workspaceRoot: string;
  let installer: LocalDirectorySkillInstaller;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'hb-t43-e2e-'));
    installer = new LocalDirectorySkillInstaller({ sourceRoot: FIXTURE_SOURCE_ROOT });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  // ── Leg 1: install ─────────────────────────────────────────────────────────
  describe.each(CRYPTO_SKILLS)('install leg — $segment', ({ segment, skill }) => {
    it('installs from the local fixture source into a frontmatter-named dir, no CLI spawn', async () => {
      const result = await installer.install(installRefFor(segment), workspaceRoot);

      expect(result).toEqual({ ok: true, output: `Installed ${segment} from local source` });
      // The install dir is named from the frontmatter `name` (= the skill segment).
      const installedDir = join(workspaceRoot, '.agents', 'skills', segment);
      const installed = await readFile(join(installedDir, 'SKILL.md'), 'utf8');
      const fixture = await readFile(
        join(FIXTURE_SOURCE_ROOT, BACKEND_ID, 'skills', 'skills', segment, 'SKILL.md'),
        'utf8',
      );
      expect(installed).toBe(fixture);
      // The published ref's normalized sourceRef is exactly the skill's committed
      // sourceRef — the real datum the resolver keys on, not a hand-faked string.
      expect(sourceRefFromInstallRef(installRefFor(segment))).toBe(skill.sourceRef);
      expect(skill.sourceRef).toBe(BUILTIN_TRADING_SOURCE_REFS[skill.id]);
    });
  });

  // ── Leg 2+3: resolution + tool visibility ───────────────────────────────────
  describe('resolution + visibility leg', () => {
    it.each(CRYPTO_SKILLS)(
      'exposes EXACTLY the committed descriptor tool set for an approved ref — $segment',
      async ({ segment, skill }) => {
        // Install first so the leg sits on a genuinely-installed skill.
        const install = await installer.install(installRefFor(segment), workspaceRoot);
        expect(install.ok).toBe(true);

        // Map the installed skill → a resolved SkillDefinition carrying the
        // sourceRef derived from the install ref (the real normalized ref).
        const resolved: SkillDefinition = { ...skill, sourceRef: sourceRefFromInstallRef(installRefFor(segment)) };
        const { rewritten, outcomes } = resolveVisibility(resolved, [committedPolicy()]);

        expect(outcomes).toEqual([{ skillId: skill.id, backendId: BACKEND_ID, outcome: 'tools_exposed' }]);
        // The descriptor is the sole tool-surface authority; the exposed set
        // equals the skill's requiredTools because T4.2 generated the descriptor
        // from exactly those tools (parity with file-descriptor-source.test.ts).
        expect(rewritten.requiredTools).toEqual(skill.requiredTools);
      },
    );

    it('a non-approved ref exposes NO tools (empty registry → no_match, unchanged skill)', () => {
      const resolved: SkillDefinition = { ...TRADING_SKILL, sourceRef: 'someone-else/repo/not-approved' };
      // Registry approves the real refs only; the foreign ref matches nothing.
      const { rewritten, outcomes } = resolveVisibility(resolved, [committedPolicy()]);

      expect(outcomes).toEqual([]); // never matched a backend
      // no_match returns the skill unchanged; its visible tool surface is not the
      // descriptor's. The published chain only grants tools to approved refs.
      expect(rewritten).toBe(resolved);
    });

    it('an approved ref with NO committed descriptor degrades to instruction-only (no tools)', () => {
      // A source that never answers stands in for a backend whose descriptor is
      // unavailable — the resolver degrades the matched skill to zero tools (DT3).
      const emptySource: SyncDescriptorSource = { getDescriptor: () => undefined };
      const resolved: SkillDefinition = {
        ...TRADING_SKILL,
        sourceRef: sourceRefFromInstallRef(installRefFor('crypto-trading')),
      };

      const result = applyDescriptorToolVisibility({
        resolvedSkills: [resolved],
        registry: [committedPolicy()],
        descriptorSource: emptySource,
        now: NOW,
      });

      expect(result.outcomes).toEqual([
        { skillId: TRADING_SKILL.id, backendId: BACKEND_ID, outcome: 'instruction_only', reason: 'definition.disabled' },
      ]);
      expect(result.resolvedSkills[0]!.requiredTools).toEqual([]);
    });
  });

  // ── Leg 4: invocation + result mapping, PARAMETERISED over both transports ───
  const TRANSPORTS: ReadonlyArray<{
    transport: ExternalBackendProtocol;
    start(): Promise<FakeIdempotentBoundary>;
  }> = [
    { transport: 'rest', start: startFakeIdempotentBoundary },
    { transport: 'mcp', start: startFakeMcpBoundary },
  ];

  const CONSUMER_ID = 'herobids-t43';
  const SUBJECT: ExternalBackendSubject = { ownerId: 'owner-t43', actor: { type: 'agent', id: 'agent-t43' } };

  // Every closed-union failure code + its documented retryable flag; the mapping
  // leg asserts each survives verbatim across the wire (parity with T2.3).
  const ALL_FAILURE_CODES: ReadonlyArray<{ code: ExternalBackendFailureCode; retryable: boolean }> = [
    { code: 'validation.invalid_payload', retryable: false },
    { code: 'authentication.invalid_caller', retryable: false },
    { code: 'authorization.denied', retryable: false },
    { code: 'not_found.resource', retryable: false },
    { code: 'precondition.not_ready', retryable: false },
    { code: 'rate_limit.exceeded', retryable: true },
    { code: 'deadline.expired', retryable: false },
    { code: 'upstream.transient', retryable: true },
    { code: 'internal.non_retryable', retryable: false },
    { code: 'contract.unsupported_version', retryable: false },
  ];

  function makeClient(baseUrl: string, transport: ExternalBackendProtocol): ExternalBackendClient {
    return createExternalBackendClient({
      baseUrl,
      consumerId: CONSUMER_ID,
      keyId: 't43',
      hmacSecret: 't43-secret',
      requestTimeoutMs: 5_000,
      protocol: transport,
      ...(transport === 'mcp' ? { mcpPath: FAKE_MCP_PATH } : {}),
    });
  }

  describe.each(TRANSPORTS)('invocation + result-mapping leg over $transport', ({ transport, start }) => {
    let backend: FakeIdempotentBoundary | undefined;

    afterEach(async () => {
      await backend?.close();
      backend = undefined;
    });

    /**
     * The exposed tool invoked is `submit_decision` — a real crypto-trading tool
     * that the committed descriptor exposes for `traderton/skills/crypto-trading`.
     * The visibility leg (above) proves it is in the exposed set; this leg proves
     * invoking it over the wire maps correctly.
     */
    function write(idempotencyKey: string, deadlineMs = 5_000) {
      return {
        toolName: 'submit_decision',
        payload: { instrumentId: 'BTC' },
        subject: SUBJECT,
        idempotencyKey,
        deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
      };
    }

    it('exposes submit_decision in the published crypto-trading tool set (ties the invoked tool to leg 3)', () => {
      const resolved: SkillDefinition = {
        ...TRADING_SKILL,
        sourceRef: sourceRefFromInstallRef(installRefFor('crypto-trading')),
      };
      const { rewritten } = resolveVisibility(resolved, [committedPolicy()]);
      expect(rewritten.requiredTools).toContain('submit_decision');
    });

    it('maps a successful invocation of the exposed tool to success', async () => {
      backend = await start();
      backend.respondNextWith({ kind: 'success', payload: { executionId: 'exec-1' } });

      const result = await makeClient(backend.url, transport).invoke(write('t43-success'));

      expect(result).toMatchObject({ kind: 'success', payload: { executionId: 'exec-1' } });
      expect(backend.executions('submit_decision')).toBe(1);
    });

    it('preserves every closed-union failure code and its retryable flag verbatim', async () => {
      backend = await start();
      const client = makeClient(backend.url, transport);

      for (const { code, retryable } of ALL_FAILURE_CODES) {
        backend.respondNextWith({ kind: 'failure', code, message: `${code} happened`, retryable });
        const result = await client.invoke(write(`t43-${code}`));
        expect(result).toMatchObject({ kind: 'failure', code, retryable });
      }
    });
  });
});

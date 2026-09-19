/**
 * Mechanical drift guards — keep the committed self-documenting sources of truth
 * in lockstep with the code that reads them. herobids already carries the
 * `.env.example` convention (AGENTS.md rule + docs/best-practices/configuration.md)
 * but had no mechanical guard; this adds one, mirroring the sibling traderton test.
 *
 * Guard 1 — `.env.example` ⊇ every env var the code reads:
 *   (a) every ENV_OVERRIDES key in the worker + api config.ts maps, AND
 *   (b) every `process.env['X']` literal across the live apps + packages (ex-tests),
 *   plus a no-stale-entries check.
 * Guard 2 — `config/default.yaml` has a value for (near enough) every leaf the
 *   code documents, i.e. every ENV_OVERRIDES target path resolves to a present key.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// apps/worker/src → repo root is ../../..
const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '../../..');
const ENV_EXAMPLE = resolve(REPO_ROOT, '.env.example');
// herobids has TWO ENV_OVERRIDES maps — one per long-running process. Both read
// operator env into the shared config, so both must stay documented in
// `.env.example` and their target paths must resolve in default.yaml.
const CONFIG_TS_FILES = [
  resolve(REPO_ROOT, 'apps/worker/src/config.ts'),
  resolve(REPO_ROOT, 'apps/api/src/config.ts'),
];
const DEFAULT_YAML = resolve(REPO_ROOT, 'config/default.yaml');
// herobids reads env in two layers — the worker's ENV_OVERRIDES map AND many
// direct `process.env['X']` literals scattered across both apps/*/src and
// packages/*/src. traderton only had packages/; herobids has apps too.
const CODE_ROOTS = [resolve(REPO_ROOT, 'apps'), resolve(REPO_ROOT, 'packages')];

/**
 * Env vars the drift guard intentionally does NOT require in `.env.example`.
 * These are NOT operator/deploy-time inputs (which is what `.env.example`
 * documents) — they are either container-injected blobs the worker writes into
 * each agent container ("DO NOT SET MANUALLY", per the `.env.example` header) or
 * pure infra-runtime values set by the platform, not by a human editing `.env`.
 */
const IGNORED_ENV_VARS = new Set<string>([
  // Dynamic loop variable in applyEnvOverrides (`process.env[envVar]`), not a literal.
  'envVar',
  // ── Container-injected by the worker (DockerAgentManager / runtime-lifecycle) ──
  // These are computed per-agent and written into the agent container's env; an
  // operator never sets them in `.env`. The agent entrypoint (agent.ts) reads them.
  'AGENT_BROWSER_CONFIG', // agent-browser CDP config path, set by the entrypoint
  'AGENT_CONFIG', // per-agent config blob injected into the container
  'AGENT_DOCUMENTS_DIR', // per-agent documents mount, injected by the runtime
  'AGENT_ID', // per-agent identifier injected into the container
  'AGENT_RUNTIME_CONFIG_JSON', // per-agent runtime config JSON injected by the worker
  'AGENT_WORKSPACE_ROOT', // in-container workspace path, injected by the runtime
  'BOUNDARY_CONFIG_JSON', // per-agent boundary/HMAC config JSON injected by the worker
  'EXTERNAL_SKILLS_CONFIG_JSON', // per-agent external-skills config JSON injected by the worker
  'TRADING_HOURS_JSON', // per-agent trading-hours JSON injected by the worker
  'OPENROUTER_PROVIDER_CONTROLS', // per-agent OpenRouter controls JSON injected by the worker
  'SESSION_ID', // per-agent session id injected into the container
  'TOOL_POLICY', // per-agent tool policy blob injected into the container
  // ── Pure infra-runtime values (set by the platform / deployment, not `.env`) ──
  'SERVER_ID', // API server identity; falls back to os.hostname()
  'HEROBIDS_CONFIG_DIR', // config-dir override for the presets loader (deploy layout)
  'NODE_ENV', // runtime environment selector, set by docker-compose, not `.env`
  'DOCKER_SOCKET_PATH', // Docker socket path for admin utils, infra-provided
  'BROWSER_POOL_URL', // browser-pool endpoint injected by the runtime, not `.env`
  'SANDBOX_ALLOWED_HOSTS', // per-agent sandbox allowlist injected by the runtime
]);

function walkTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
      out.push(...walkTsFiles(p));
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.spec.ts') &&
      !name.endsWith('.d.ts')
    ) {
      out.push(p);
    }
  }
  return out;
}

function liveTsFiles(): string[] {
  return CODE_ROOTS.flatMap((root) => walkTsFiles(root));
}

/** Extract every ENV_OVERRIDES key name across the worker + api config.ts maps. */
function envOverrideKeys(): string[] {
  // Match lines like: `  FOO_BAR: { path: '...' , type: '...' },`
  const keys = new Set<string>();
  for (const file of CONFIG_TS_FILES) {
    const src = readFileSync(file, 'utf8');
    const re = /^\s{2}([A-Z][A-Z0-9_]+):\s*\{\s*path:/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) keys.add(m[1]!);
  }
  return [...keys];
}

/** Extract every ENV_OVERRIDES target path across the worker + api config.ts maps. */
function envOverridePaths(): string[] {
  const paths = new Set<string>();
  for (const file of CONFIG_TS_FILES) {
    const src = readFileSync(file, 'utf8');
    const re = /path:\s*['"]([a-zA-Z0-9_.]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) paths.add(m[1]!);
  }
  return [...paths];
}

/** Extract every distinct `process.env['X']` literal across the live apps + packages. */
function processEnvLiterals(): string[] {
  const keys = new Set<string>();
  for (const file of liveTsFiles()) {
    const src = readFileSync(file, 'utf8');
    const re = /process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) keys.add(m[1]!);
  }
  return [...keys];
}

/** Env var names documented in .env.example (both active `KEY=` and commented `# KEY=`). */
function envExampleKeys(): Set<string> {
  const src = readFileSync(ENV_EXAMPLE, 'utf8');
  const keys = new Set<string>();
  const re = /^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) keys.add(m[1]!);
  return keys;
}

describe('.env.example is in lockstep with the code that reads env vars', () => {
  it('documents every ENV_OVERRIDES key from config.ts', () => {
    const documented = envExampleKeys();
    const missing = envOverrideKeys()
      .filter((k) => !IGNORED_ENV_VARS.has(k))
      .filter((k) => !documented.has(k));
    expect(missing, `ENV_OVERRIDES keys missing from .env.example: ${missing.join(', ')}`).toEqual([]);
  });

  it('documents every process.env[...] literal read by the live apps and packages', () => {
    const documented = envExampleKeys();
    const missing = processEnvLiterals()
      .filter((k) => !IGNORED_ENV_VARS.has(k))
      .filter((k) => !documented.has(k));
    expect(missing, `process.env[...] literals missing from .env.example: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not document env vars the code never reads (no stale entries)', () => {
    const codeVars = new Set<string>([...envOverrideKeys(), ...processEnvLiterals()]);
    const stale = [...envExampleKeys()].filter((k) => !codeVars.has(k) && !IGNORED_ENV_VARS.has(k));
    expect(stale, `Env vars documented in .env.example but never read by the code: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('config/default.yaml has a value for every ENV_OVERRIDES target (self-documenting)', () => {
  // Per docs/best-practices/configuration.md: even SCHEMA-DEFAULTED config must
  // appear in default.yaml so the file is the documentation. Each ENV_OVERRIDES
  // path (e.g. `marketData.birdeye.apiKey`) must resolve to a present leaf key.
  //
  // EXCLUDED: paths that are `.optional()` in the schema with NO `.default()` —
  // these have no canonical baseline value, herobids' own default.yaml omits them
  // too, and inventing a value would encode a behaviour choice. They are set only
  // per deployment via the env override. Verified against
  // packages/domain/src/config/schema.ts:
  //   - alerts.telegram.webhookUrl      → z.string().url().optional()       (schema.ts:525)
  //   - alerts.email.ses.configurationSetName → z.string().optional()       (schema.ts:551)
  const OPTIONAL_NO_DEFAULT_PATHS = new Set<string>([
    'alerts.telegram.webhookUrl',
    'alerts.email.ses.configurationSetName',
  ]);
  const yaml = readFileSync(DEFAULT_YAML, 'utf8');

  function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function pathPresent(dotted: string): boolean {
    // Cheap structural check: every segment (ancestors + leaf) must appear as a
    // `key:` line somewhere in the file (sufficient for this 2-space YAML; the
    // loadConfig parse test is the authoritative deep check).
    const segments = dotted.split('.');
    return segments.every((seg) => new RegExp(`(^|\\n)\\s*${escapeRe(seg)}:`, 'm').test(yaml));
  }

  it('every ENV_OVERRIDES target path is present in default.yaml', () => {
    const missing = envOverridePaths()
      .filter((p) => !OPTIONAL_NO_DEFAULT_PATHS.has(p))
      .filter((p) => !pathPresent(p));
    expect(missing, `ENV_OVERRIDES target paths missing a value in default.yaml: ${missing.join(', ')}`).toEqual([]);
  });
});

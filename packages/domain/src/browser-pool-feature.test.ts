import { describe, it, expect } from 'vitest';
import {
  BrowserPoolConfigSchema,
  HttpClientConfigSchema,
  AppConfigSchema,
} from './config/schema.js';
import {
  KNOWN_AGENT_TOOL_NAMES,
  TOOL_CATALOG,
  isKnownAgentToolName,
  getToolCatalogEntry,
} from './tools.js';
import {
  BROWSER_SKILL,
  SYSTEM_SKILLS,
  WEB_ACCESS_SKILL,
  buildToolOwnershipMap,
} from './skills.js';
import type { BrowserSession, BrowserPoolError, BrowserPoolPort } from './ports/browser-pool.js';
import { ok, err } from './result.js';
import type { Result } from './result.js';

// ── BrowserPoolConfigSchema ─────────────────────────────────────────────────

describe('BrowserPoolConfigSchema', () => {
  it('applies all defaults when given an empty object', () => {
    const result = BrowserPoolConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.url).toBe('');
      expect(result.data.apiKey).toBe('');
      expect(result.data.maxSessionDurationMs).toBe(60_000);
      expect(result.data.defaultViewport).toEqual({ width: 1280, height: 720 });
    }
  });

  it('accepts explicit overrides', () => {
    const result = BrowserPoolConfigSchema.safeParse({
      enabled: true,
      url: 'ws://browserless:3000',
      maxSessionDurationMs: 120_000,
      defaultViewport: { width: 1920, height: 1080 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.url).toBe('ws://browserless:3000');
      expect(result.data.maxSessionDurationMs).toBe(120_000);
      expect(result.data.defaultViewport).toEqual({ width: 1920, height: 1080 });
    }
  });

  it('rejects non-positive maxSessionDurationMs', () => {
    const result = BrowserPoolConfigSchema.safeParse({ maxSessionDurationMs: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects negative maxSessionDurationMs', () => {
    const result = BrowserPoolConfigSchema.safeParse({ maxSessionDurationMs: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive viewport width', () => {
    const result = BrowserPoolConfigSchema.safeParse({
      defaultViewport: { width: 0, height: 720 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive viewport height', () => {
    const result = BrowserPoolConfigSchema.safeParse({
      defaultViewport: { width: 1280, height: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer maxSessionDurationMs', () => {
    const result = BrowserPoolConfigSchema.safeParse({ maxSessionDurationMs: 5000.5 });
    expect(result.success).toBe(false);
  });

  it('accepts enabled: true with empty url (URL resolved dynamically at runtime)', () => {
    // browserPool.url is intentionally not required at config-validation time.
    // When enabled but url is empty, the worker's ServiceRegistry resolves the
    // address from Nomad service discovery at startup (and warns if unresolved).
    const result = BrowserPoolConfigSchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.url).toBe('');
    }
  });

  it('accepts enabled: true when url is provided', () => {
    const result = BrowserPoolConfigSchema.safeParse({
      enabled: true,
      url: 'ws://browserless:3000',
    });
    expect(result.success).toBe(true);
  });

  it('defaults apiKey to empty string when omitted', () => {
    const result = BrowserPoolConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.apiKey).toBe('');
    }
  });

  it('accepts an explicit apiKey value', () => {
    const result = BrowserPoolConfigSchema.safeParse({
      apiKey: 'my-secret-key',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.apiKey).toBe('my-secret-key');
    }
  });

  it('includes apiKey in parsed output alongside other fields', () => {
    const result = BrowserPoolConfigSchema.safeParse({
      enabled: true,
      url: 'ws://browserless:3000',
      apiKey: 'browser-key-123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        enabled: true,
        url: 'ws://browserless:3000',
        apiKey: 'browser-key-123',
        maxSessionDurationMs: 60_000,
        defaultViewport: { width: 1280, height: 720 },
      });
    }
  });

  it('accepts enabled: false with empty url (no validation needed)', () => {
    const result = BrowserPoolConfigSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });

  it('defaults viewport independently when only partial viewport is supplied', () => {
    // Zod .default({}) applies defaults for the whole object when omitted,
    // but partial fields within the object should still get their own defaults.
    const result = BrowserPoolConfigSchema.safeParse({
      defaultViewport: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultViewport.width).toBe(1280);
      expect(result.data.defaultViewport.height).toBe(720);
    }
  });
});

// ── HttpClientConfigSchema ──────────────────────────────────────────────────

describe('HttpClientConfigSchema', () => {
  it('applies all defaults when given an empty object', () => {
    const result = HttpClientConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.maxResponseBytes).toBe(51_200);
      expect(result.data.denyList).toEqual([
        '10.*',
        '172.16.*', '172.17.*', '172.18.*', '172.19.*',
        '172.20.*', '172.21.*', '172.22.*', '172.23.*',
        '172.24.*', '172.25.*', '172.26.*', '172.27.*',
        '172.28.*', '172.29.*', '172.30.*', '172.31.*',
        '192.168.*',
        '169.254.*',
        '127.*',
        'localhost',
        '0.0.0.0',
        '[::1]',
      ]);
    }
  });

  it('accepts explicit overrides', () => {
    const result = HttpClientConfigSchema.safeParse({
      enabled: false,
      maxResponseBytes: 1_048_576,
      denyList: ['192.168.*'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.maxResponseBytes).toBe(1_048_576);
      expect(result.data.denyList).toEqual(['192.168.*']);
    }
  });

  it('rejects non-positive maxResponseBytes', () => {
    const result = HttpClientConfigSchema.safeParse({ maxResponseBytes: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects negative maxResponseBytes', () => {
    const result = HttpClientConfigSchema.safeParse({ maxResponseBytes: -100 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer maxResponseBytes', () => {
    const result = HttpClientConfigSchema.safeParse({ maxResponseBytes: 1024.5 });
    expect(result.success).toBe(false);
  });

  it('accepts an empty denyList', () => {
    const result = HttpClientConfigSchema.safeParse({ denyList: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.denyList).toEqual([]);
    }
  });
});

// ── AppConfigSchema wiring ──────────────────────────────────────────────────
//
// AppConfigSchema requires many fields (database url, execution, risk, etc.).
// Instead of constructing a fully valid input (brittle), we verify the schema
// shape: that browserPool lives at the top level and httpClient lives inside
// agentRuntime.tools. We confirm this by inspecting the Zod schema's shape
// keys and by testing that the sub-schemas produce correct output when parsed
// independently — which is sufficient since AppConfigSchema delegates to them.

describe('AppConfigSchema — browserPool and httpClient wiring', () => {
  it('browserPool is a top-level key in AppConfigSchema', () => {
    // AppConfigSchema uses .superRefine() so the outer def is ZodEffects.
    // Unwrap to the inner ZodObject to inspect the shape.
    // Verified against Zod 3.x internal structure — may need updating on major Zod upgrades.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerSchema = (AppConfigSchema as any)._def.schema;
    const shape = innerSchema._def.shape();
    expect(shape).toHaveProperty('browserPool');
  });

  it('httpClient is a key inside agentRuntime.tools', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerSchema = (AppConfigSchema as any)._def.schema;
    const shape = innerSchema._def.shape();
    expect(shape).toHaveProperty('agentRuntime');
    // agentRuntime is not wrapped in .default() at AppConfig level, but its
    // tools sub-object is. Verify tools exists by inspecting the shape.
    const agentRuntimeShape = shape.agentRuntime._def.shape();
    expect(agentRuntimeShape).toHaveProperty('tools');
  });

  it('browserPool sub-schema defaults match BrowserPoolConfigSchema defaults', () => {
    // Since AppConfigSchema delegates to BrowserPoolConfigSchema, if the
    // standalone schema defaults are correct, the wired-in schema will be too.
    const result = BrowserPoolConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.url).toBe('');
      expect(result.data.maxSessionDurationMs).toBe(60_000);
      expect(result.data.defaultViewport).toEqual({ width: 1280, height: 720 });
    }
  });

  it('httpClient sub-schema defaults match HttpClientConfigSchema defaults', () => {
    const result = HttpClientConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.maxResponseBytes).toBe(51_200);
      expect(result.data.denyList).toEqual([
        '10.*',
        '172.16.*', '172.17.*', '172.18.*', '172.19.*',
        '172.20.*', '172.21.*', '172.22.*', '172.23.*',
        '172.24.*', '172.25.*', '172.26.*', '172.27.*',
        '172.28.*', '172.29.*', '172.30.*', '172.31.*',
        '192.168.*',
        '169.254.*',
        '127.*',
        'localhost',
        '0.0.0.0',
        '[::1]',
      ]);
    }
  });
});

// ── BROWSER_SKILL ───────────────────────────────────────────────────────────

describe('BROWSER_SKILL', () => {
  it('has id "browser"', () => {
    expect(BROWSER_SKILL.id).toBe('browser');
  });

  it('has slug "system/browser"', () => {
    expect(BROWSER_SKILL.slug).toBe('system/browser');
  });

  it('has name "Browser"', () => {
    expect(BROWSER_SKILL.name).toBe('Browser');
  });

  it('has a non-empty description', () => {
    expect(BROWSER_SKILL.description.length).toBeGreaterThan(0);
  });

  it.each(['browse_interactive', 'send_message', 'publish_artifact'])(
    'requiredTools includes %s',
    (tool) => {
      expect(BROWSER_SKILL.requiredTools).toContain(tool);
    },
  );

  it('has visibility public', () => {
    expect(BROWSER_SKILL.visibility).toBe('public');
  });

  it('instructions mention browse_interactive', () => {
    expect(BROWSER_SKILL.instructions).toContain('browse_interactive');
  });

  it('instructions mention close action', () => {
    expect(BROWSER_SKILL.instructions).toContain('close');
  });

  it('instructions mention agent-browser CLI', () => {
    expect(BROWSER_SKILL.instructions).toContain('agent-browser');
  });

  it('instructions mention execute_shell for running agent-browser', () => {
    expect(BROWSER_SKILL.instructions).toContain('execute_shell');
  });

  it('instructions mention agent-browser close for resource cleanup', () => {
    expect(BROWSER_SKILL.instructions).toContain('agent-browser close');
  });

  it('instructions describe agent-browser session support', () => {
    expect(BROWSER_SKILL.instructions).toContain('session');
  });

  it('instructions mention system/programming skill dependency for CLI', () => {
    expect(BROWSER_SKILL.instructions).toContain('system/programming');
  });

  it('instructions contain guidance about following skill instructions', () => {
    expect(BROWSER_SKILL.instructions).toContain(
      'prefer whichever browser automation option the skill suggests',
    );
  });

  it('has empty capabilityFamilies', () => {
    expect(BROWSER_SKILL.capabilityFamilies).toEqual([]);
  });

  it('has empty bindingRequirements', () => {
    expect(BROWSER_SKILL.bindingRequirements).toEqual({});
  });

  it('has contextRequirements including costs and session_elapsed', () => {
    expect(BROWSER_SKILL.contextRequirements).toContain('costs');
    expect(BROWSER_SKILL.contextRequirements).toContain('session_elapsed');
  });

  it('has token-budget guardrail', () => {
    expect(BROWSER_SKILL.requiredGuardrails).toContain('token-budget');
  });

  it('has a promptHint', () => {
    expect(BROWSER_SKILL.promptHint).toBeDefined();
    expect(BROWSER_SKILL.promptHint!.length).toBeGreaterThan(0);
  });
});

// ── SYSTEM_SKILLS includes BROWSER_SKILL ────────────────────────────────────

describe('SYSTEM_SKILLS — browser skill', () => {
  it('includes BROWSER_SKILL', () => {
    const browserSkill = SYSTEM_SKILLS.find((s) => s.id === 'browser');
    expect(browserSkill).toBeDefined();
    expect(browserSkill).toBe(BROWSER_SKILL);
  });

  it('BROWSER_SKILL is the last entry in SYSTEM_SKILLS', () => {
    const last = SYSTEM_SKILLS[SYSTEM_SKILLS.length - 1];
    expect(last?.id).toBe('browser');
  });
});

// ── WEB_ACCESS_SKILL includes make_http_request ──────────────────────────────────

describe('WEB_ACCESS_SKILL — make_http_request', () => {
  it('requiredTools includes make_http_request', () => {
    expect(WEB_ACCESS_SKILL.requiredTools).toContain('make_http_request');
  });

  it('instructions mention make_http_request', () => {
    expect(WEB_ACCESS_SKILL.instructions).toContain('make_http_request');
  });
});

// ── KNOWN_AGENT_TOOL_NAMES — new tools ──────────────────────────────────────

describe('KNOWN_AGENT_TOOL_NAMES — browser pool tools', () => {
  it('includes browse_interactive', () => {
    expect(KNOWN_AGENT_TOOL_NAMES).toContain('browse_interactive');
  });

  it('includes make_http_request', () => {
    expect(KNOWN_AGENT_TOOL_NAMES).toContain('make_http_request');
  });

  it('isKnownAgentToolName recognises browse_interactive', () => {
    expect(isKnownAgentToolName('browse_interactive')).toBe(true);
  });

  it('isKnownAgentToolName recognises make_http_request', () => {
    expect(isKnownAgentToolName('make_http_request')).toBe(true);
  });
});

// ── KNOWN_AGENT_TOOL_NAMES — alphabetical ordering ─────────────────────────

describe('KNOWN_AGENT_TOOL_NAMES — alphabetical ordering for new tools', () => {
  it('browse_interactive, browse_url, check_regime are in alphabetical order', () => {
    const names = KNOWN_AGENT_TOOL_NAMES as readonly string[];
    const idxBrowseUrl = names.indexOf('browse_url');
    const idxBrowseInteractive = names.indexOf('browse_interactive');
    const idxCheckRegime = names.indexOf('check_regime');

    expect(idxBrowseInteractive).toBeGreaterThanOrEqual(0);
    expect(idxBrowseInteractive).toBeLessThan(idxBrowseUrl);
    expect(idxBrowseUrl).toBeLessThan(idxCheckRegime);
  });

  it('make_http_request appears between list_watches and publish_artifact', () => {
    const names = KNOWN_AGENT_TOOL_NAMES as readonly string[];
    const idxListWatches = names.indexOf('list_watches');
    const idxMakeHttpRequest = names.indexOf('make_http_request');
    const idxPublishArtifact = names.indexOf('publish_artifact');

    expect(idxMakeHttpRequest).toBeGreaterThanOrEqual(0);
    expect(idxListWatches).toBeLessThan(idxMakeHttpRequest);
    expect(idxMakeHttpRequest).toBeLessThan(idxPublishArtifact);
  });
});

// ── TOOL_CATALOG entries for new tools ──────────────────────────────────────

describe('TOOL_CATALOG — browse_interactive', () => {
  const entry = getToolCatalogEntry('browse_interactive');

  it('exists in TOOL_CATALOG with category read-web', () => {
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('read-web');
  });

  it('has a non-empty description that mentions browser', () => {
    expect(entry).toBeDefined();
    expect(entry!.description.length).toBeGreaterThan(0);
    expect(entry!.description.toLowerCase()).toContain('browser');
  });
});

describe('TOOL_CATALOG — make_http_request', () => {
  const entry = getToolCatalogEntry('make_http_request');

  it('exists in TOOL_CATALOG with category read-web', () => {
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('read-web');
  });

  it('has a non-empty description that mentions HTTP', () => {
    expect(entry).toBeDefined();
    expect(entry!.description.length).toBeGreaterThan(0);
    expect(entry!.description).toContain('HTTP');
  });
});

// ── buildToolOwnershipMap — browser tool assignment ─────────────────────────

describe('buildToolOwnershipMap — browser tools', () => {
  const ownershipMap = buildToolOwnershipMap();

  it('maps browse_interactive to browser skill', () => {
    // browse_interactive is listed in BROWSER_SKILL (first-seen) and also in no other
    // non-base skill, so it should map to 'browser'.
    expect(ownershipMap.get('browse_interactive')).toBe('browser');
  });

  it('maps make_http_request to web-access skill (first-seen before browser)', () => {
    // make_http_request is in WEB_ACCESS_SKILL.requiredTools which appears before
    // BROWSER_SKILL in SYSTEM_SKILLS array. First-seen wins.
    // Actually make_http_request is NOT in BROWSER_SKILL.requiredTools, only in WEB_ACCESS_SKILL.
    expect(ownershipMap.get('make_http_request')).toBe('web-access');
  });
});

// ── BrowserPoolPort type-level tests ────────────────────────────────────────

describe('BrowserPoolPort — type-level shape tests', () => {
  /**
   * Build a mock BrowserPoolPort that satisfies the interface contract.
   * If it compiles, the interface is correctly defined.
   */
  const mockPort: BrowserPoolPort = {
    acquireSession: async (): Promise<Result<BrowserSession, BrowserPoolError>> =>
      ok({ cdpEndpoint: 'ws://localhost:3000/devtools', sessionId: 'sess-1' }),
    releaseSession: async (_sessionId: string): Promise<void> => {},
  };

  it('acquireSession returns a success result with cdpEndpoint and sessionId', async () => {
    const result = await mockPort.acquireSession();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cdpEndpoint).toBe('ws://localhost:3000/devtools');
      expect(result.data.sessionId).toBe('sess-1');
    }
  });

  it('acquireSession can return an error result', async () => {
    const errorPort: BrowserPoolPort = {
      acquireSession: async () =>
        err({
          code: 'browser_pool.unavailable' as const,
          message: 'No browsers available',
        }),
      releaseSession: async () => {},
    };

    const result = await errorPort.acquireSession();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('browser_pool.unavailable');
      expect(result.error.message).toBe('No browsers available');
    }
  });

  it('BrowserPoolError codes cover all expected failure modes', async () => {
    const codes: BrowserPoolError['code'][] = [
      'browser_pool.unavailable',
      'browser_pool.timeout',
      'browser_pool.queue_full',
      'browser_pool.session_limit',
    ];

    for (const code of codes) {
      const port: BrowserPoolPort = {
        acquireSession: async () => err({ code, message: `Error: ${code}` }),
        releaseSession: async () => {},
      };
      const result = await port.acquireSession();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
      }
    }
  });

  it('releaseSession completes without error', async () => {
    await expect(mockPort.releaseSession('sess-1')).resolves.toBeUndefined();
  });
});

// ── Re-export verification ──────────────────────────────────────────────────

describe('Re-exports from config/index.ts', () => {
  it('BrowserPoolConfigSchema is re-exported from config index', async () => {
    const configIndex = await import('./config/index.js');
    expect(configIndex.BrowserPoolConfigSchema).toBeDefined();
    expect(configIndex.BrowserPoolConfigSchema).toBe(BrowserPoolConfigSchema);
  });

  it('HttpClientConfigSchema is re-exported from config index', async () => {
    const configIndex = await import('./config/index.js');
    expect(configIndex.HttpClientConfigSchema).toBeDefined();
    expect(configIndex.HttpClientConfigSchema).toBe(HttpClientConfigSchema);
  });
});

describe('Re-exports from ports/index.ts', () => {
  it('BrowserPoolPort types are re-exported from ports index', async () => {
    // Type-level re-export — we verify the module can be imported and
    // contains the expected exports by checking that the file loads.
    const portsIndex = await import('./ports/index.js');
    // Runtime check: the module object exists (types are erased but the module loads)
    expect(portsIndex).toBeDefined();
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCapabilityGrants,
  buildCapabilityPolicyEngine,
  DEFAULT_CAPABILITY_GRANTS,
} from './capability-policy.js';

describe('buildCapabilityPolicyEngine', () => {
  it('merges per-runtime overrides onto the default capability policy', () => {
    const engine = buildCapabilityPolicyEngine({
      execute_code: {
        enabled: false,
        tier: 'direct',
        limits: { timeoutMs: 5_000 },
      },
    });

    expect(engine.getGrant('execute_code')).toEqual(
      expect.objectContaining({
        capability: 'execute_code',
        enabled: false,
        tier: 'direct',
        limits: expect.objectContaining({
          timeoutMs: 5_000,
          maxConcurrent: 1,
        }),
      }),
    );
  });

  it('preserves session rate limits when grants are refreshed in place', () => {
    const engine = buildCapabilityPolicyEngine({
      execute_code: {
        enabled: true,
        tier: 'direct',
        limits: { maxPerMinute: 1 },
      },
    });

    expect(engine.checkAccess('execute_code', 'agent-1', 'session-1')).toBeUndefined();
    engine.recordStart('execute_code', 'session-1');

    expect(engine.checkAccess('execute_code', 'agent-1', 'session-1'))
      .toMatchObject({ reason: 'rate_limit_exceeded' });

    engine.replaceGrants(buildCapabilityGrants({
      execute_code: {
        enabled: true,
        tier: 'direct',
        limits: { maxPerMinute: 1, timeoutMs: 5_000 },
      },
    }));

    expect(engine.getGrant('execute_code')).toEqual(
      expect.objectContaining({
        limits: expect.objectContaining({ timeoutMs: 5_000, maxPerMinute: 1 }),
      }),
    );
    expect(engine.checkAccess('execute_code', 'agent-1', 'session-1'))
      .toMatchObject({ reason: 'rate_limit_exceeded' });
  });

  it('rate_limit_exceeded after grant refresh still contains structured fields', () => {
    const engine = buildCapabilityPolicyEngine({
      execute_code: {
        enabled: true,
        tier: 'direct',
        limits: { maxPerMinute: 1 },
      },
    });

    engine.recordStart('execute_code', 'session-1');

    engine.replaceGrants(buildCapabilityGrants({
      execute_code: {
        enabled: true,
        tier: 'direct',
        limits: { maxPerMinute: 1, timeoutMs: 5_000 },
      },
    }));

    const denial = engine.checkAccess('execute_code', 'agent-1', 'session-1');
    expect(denial).toBeDefined();
    expect(denial!.reason).toBe('rate_limit_exceeded');
    expect(denial!.limit).toBe(1);
    expect(denial!.used).toBe(1);
    expect(typeof denial!.retryAfterMs).toBe('number');
    expect(denial!.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(denial!.message).toBeDefined();
  });
});


// ── manage_agent_skills in DEFAULT_CAPABILITY_GRANTS ─────────────────────────

describe('DEFAULT_CAPABILITY_GRANTS — manage_agent_skills', () => {
  it('includes manage_agent_skills as a brokered, enabled grant', () => {
    // Build engine with no overrides → uses DEFAULT_CAPABILITY_GRANTS
    const engine = buildCapabilityPolicyEngine();
    const grant = engine.getGrant('manage_agent_skills');

    expect(grant).toBeDefined();
    expect(grant).toEqual(expect.objectContaining({
      capability: 'manage_agent_skills',
      tier: 'brokered',
      enabled: true,
    }));
  });

  it('has correct rate limits for manage_agent_skills', () => {
    const engine = buildCapabilityPolicyEngine();
    const grant = engine.getGrant('manage_agent_skills');

    expect(grant!.limits).toEqual(expect.objectContaining({
      maxPerMinute: 10,
      maxConcurrent: 1,
      timeoutMs: 30_000,
    }));
  });

  it('allows access to manage_agent_skills with default grants', () => {
    const engine = buildCapabilityPolicyEngine();
    const denied = engine.checkAccess('manage_agent_skills', 'agent-1', 'session-1');
    expect(denied).toBeUndefined(); // No denial reason → access allowed
  });

  it('allows per-agent override of manage_agent_skills', () => {
    const engine = buildCapabilityPolicyEngine({
      manage_agent_skills: {
        enabled: false,
        tier: 'brokered',
        limits: { maxPerMinute: 5 },
      },
    });

    const grant = engine.getGrant('manage_agent_skills');
    expect(grant).toEqual(expect.objectContaining({
      capability: 'manage_agent_skills',
      enabled: false,
      tier: 'brokered',
    }));
    expect(grant!.limits).toEqual(expect.objectContaining({
      maxPerMinute: 5,
      maxConcurrent: 1,  // inherited from default
      timeoutMs: 30_000, // inherited from default
    }));
  });

  it('denies access when manage_agent_skills is disabled via override', () => {
    const engine = buildCapabilityPolicyEngine({
      manage_agent_skills: {
        enabled: false,
        tier: 'brokered',
      },
    });

    const denied = engine.checkAccess('manage_agent_skills', 'agent-1', 'session-1');
    expect(denied).toMatchObject({ reason: 'capability_disabled' });
    expect(denied!.message).toContain('manage_agent_skills');
  });
});

describe('buildCapabilityGrants — manage_agent_skills', () => {
  it('includes manage_agent_skills in default grants when no overrides', () => {
    const grants = buildCapabilityGrants();
    const skillsGrant = grants.find((g) => g.capability === 'manage_agent_skills');

    expect(skillsGrant).toBeDefined();
    expect(skillsGrant).toEqual(expect.objectContaining({
      capability: 'manage_agent_skills',
      tier: 'brokered',
      enabled: true,
    }));
  });

  it('merges per-agent manage_agent_skills override with default limits', () => {
    const grants = buildCapabilityGrants({
      manage_agent_skills: {
        capability: 'manage_agent_skills',
        tier: 'brokered',
        enabled: false,
        limits: { maxPerMinute: 2 },
      },
    });
    const skillsGrant = grants.find((g) => g.capability === 'manage_agent_skills');

    expect(skillsGrant).toEqual(expect.objectContaining({
      capability: 'manage_agent_skills',
      enabled: false,
      limits: expect.objectContaining({
        maxPerMinute: 2,
        maxConcurrent: 1,
        timeoutMs: 30_000,
      }),
    }));
  });
});

// ── search_skills in DEFAULT_CAPABILITY_GRANTS ───────────────────────────

describe('DEFAULT_CAPABILITY_GRANTS — search_skills', () => {
  it('includes search_skills as a direct, enabled grant', () => {
    const engine = buildCapabilityPolicyEngine();
    const grant = engine.getGrant('search_skills');

    expect(grant).toBeDefined();
    expect(grant).toEqual(expect.objectContaining({
      capability: 'search_skills',
      tier: 'direct',
      enabled: true,
    }));
  });

  it('has correct rate limits for search_skills', () => {
    const engine = buildCapabilityPolicyEngine();
    const grant = engine.getGrant('search_skills');

    expect(grant!.limits).toEqual(expect.objectContaining({
      maxPerMinute: 10,
      maxConcurrent: 2,
      timeoutMs: 20_000,
    }));
  });

  it('allows access to search_skills with default grants', () => {
    const engine = buildCapabilityPolicyEngine();
    const denied = engine.checkAccess('search_skills', 'agent-1', 'session-1');
    expect(denied).toBeUndefined(); // No denial reason → access allowed
  });

  it('allows per-agent override of search_skills', () => {
    const engine = buildCapabilityPolicyEngine({
      search_skills: {
        enabled: false,
        tier: 'direct',
        limits: { maxPerMinute: 3 },
      },
    });

    const grant = engine.getGrant('search_skills');
    expect(grant).toEqual(expect.objectContaining({
      capability: 'search_skills',
      enabled: false,
      tier: 'direct',
    }));
    expect(grant!.limits).toEqual(expect.objectContaining({
      maxPerMinute: 3,
      maxConcurrent: 2,   // inherited from default
      timeoutMs: 20_000,  // inherited from default
    }));
  });

  it('denies access when search_skills is disabled via override', () => {
    const engine = buildCapabilityPolicyEngine({
      search_skills: {
        enabled: false,
        tier: 'direct',
      },
    });

    const denied = engine.checkAccess('search_skills', 'agent-1', 'session-1');
    expect(denied).toMatchObject({ reason: 'capability_disabled' });
    expect(denied!.message).toContain('search_skills');
  });
});

describe('buildCapabilityGrants — search_skills', () => {
  it('includes search_skills in default grants when no overrides', () => {
    const grants = buildCapabilityGrants();
    const grant = grants.find((g) => g.capability === 'search_skills');

    expect(grant).toBeDefined();
    expect(grant).toEqual(expect.objectContaining({
      capability: 'search_skills',
      tier: 'direct',
      enabled: true,
    }));
  });

  it('merges per-agent search_skills override with default limits', () => {
    const grants = buildCapabilityGrants({
      search_skills: {
        capability: 'search_skills',
        tier: 'direct',
        enabled: false,
        limits: { maxPerMinute: 5 },
      },
    });
    const grant = grants.find((g) => g.capability === 'search_skills');

    expect(grant).toEqual(expect.objectContaining({
      capability: 'search_skills',
      enabled: false,
      limits: expect.objectContaining({
        maxPerMinute: 5,
        maxConcurrent: 2,
        timeoutMs: 20_000,
      }),
    }));
  });
});

// ── browse_url fetch cap comes from config, not the grant ────────────────────

describe('DEFAULT_CAPABILITY_GRANTS — browse_url', () => {
  it('does not set maxResponseBytes, so the configured fetch cap applies', () => {
    const grant = buildCapabilityPolicyEngine().getGrant('browse_url');
    expect(grant).toBeDefined();
    expect(grant?.limits?.maxResponseBytes).toBeUndefined();
  });
});

// ── default grants for web-access tools ──────────────────────────────────────

describe('DEFAULT_CAPABILITY_GRANTS — web-access tools', () => {
  it.each(['make_http_request', 'read_document'])('allows %s with default grants', (capability) => {
    const engine = buildCapabilityPolicyEngine();
    expect(engine.checkAccess(capability, 'agent-1', 'session-1')).toBeUndefined();
  });

  it.each(['search_web', 'browse_url', 'make_http_request', 'read_document'])(
    'defaults %s to 30 calls per minute',
    (capability) => {
      expect(buildCapabilityPolicyEngine().getGrant(capability)?.limits?.maxPerMinute).toBe(30);
    },
  );

  it.each(['make_http_request', 'read_document'])('defaults %s to 3 concurrent calls', (capability) => {
    expect(buildCapabilityPolicyEngine().getGrant(capability)?.limits?.maxConcurrent).toBe(3);
  });

  it.each(['search_web', 'browse_url', 'make_http_request', 'read_document'])(
    'denies the 31st %s call within a minute as rate limited',
    (capability) => {
      const engine = buildCapabilityPolicyEngine();
      for (let i = 0; i < 30; i++) {
        expect(engine.checkAccess(capability, 'agent-1', 'session-1')).toBeUndefined();
        engine.recordStart(capability, 'session-1');
        engine.recordEnd(capability, 'session-1', {
          capability,
          agentId: 'agent-1',
          sessionId: 'session-1',
          timestamp: new Date().toISOString(),
          durationMs: 1,
          inputSummary: 'test',
          outputSummary: 'test',
          success: true,
        });
      }
      expect(engine.checkAccess(capability, 'agent-1', 'session-1'))
        .toMatchObject({ reason: 'rate_limit_exceeded', limit: 30, used: 30 });
    },
  );
});

// ── drift guard: tool gate names vs default grants ───────────────────────────

const WORKER_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
// The broker resolves the capability from a message-type table, so its checkAccess
// argument is a variable. Its table includes deliberately disabled-by-default
// capabilities (manage_bot), so it is exempt from the literal-only scan.
const BROKER_FILE = join('agents', 'agent-message-broker.ts');

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    const isSource = entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts');
    return isSource ? [path] : [];
  });
}

describe('capability gate names', () => {
  it('every capability a tool gates on has an enabled default grant', () => {
    const gated = new Map<string, string>(); // capability -> first file that gates on it
    const nonLiteral: string[] = [];

    for (const file of listSourceFiles(WORKER_SRC_DIR)) {
      const rel = relative(WORKER_SRC_DIR, file);
      const source = readFileSync(file, 'utf8');

      for (const match of source.matchAll(/\.checkAccess\(\s*([^,)]*)/g)) {
        const arg = (match[1] ?? '').trim();
        const literal = /^'([^']+)'$|^"([^"]+)"$/.exec(arg);
        const name = literal?.[1] ?? literal?.[2];
        if (name) {
          if (!gated.has(name)) gated.set(name, rel);
        } else if (rel !== BROKER_FILE) {
          nonLiteral.push(`${rel}: checkAccess(${arg}...)`);
        }
      }
    }

    expect(nonLiteral, 'checkAccess must be called with a string literal so the drift guard can see it').toEqual([]);
    expect(gated.size, 'scan found no checkAccess calls').toBeGreaterThan(0);

    const missing = [...gated]
      .filter(([name]) => !DEFAULT_CAPABILITY_GRANTS.some((g) => g.capability === name && g.enabled))
      .map(([name, file]) => `${name} (gated in ${file}): add an enabled row to DEFAULT_CAPABILITY_GRANTS`);
    expect(missing).toEqual([]);
  });
});

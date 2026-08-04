/**
 * Validates staging/production environment invariants across config files,
 * Docker Compose overlays, and Caddyfiles. Catches common copy-paste errors
 * like wrong NODE_ENV, domain cross-contamination, and unsafe billing defaults.
 *
 * These checks are lightweight — they only read and parse static files, no
 * runtime or network access needed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

function readText(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

// ── Helpers for ad-hoc YAML top-level key checks ────────────────────────────
// Only parse the top-level keys we care about — no full YAML parser needed.

/** Find a top-level YAML key's block and return its raw text. */
function findYamlBlock(yaml: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*\\n((?:  .*\\n?)*)`, 'm');
  const match = yaml.match(re);
  return match?.[1] ?? undefined;
}

/** Extract a simple scalar value from a YAML block (e.g. "  key: value").
 * Strips inline YAML comments (text after " #"). */
function blockScalar(block: string | undefined, key: string): string | undefined {
  if (!block) return undefined;
  const re = new RegExp(`^\\s{2}${key}:\\s*(.+)$`, 'm');
  const raw = block.match(re)?.[1]?.trim();
  if (!raw) return undefined;
  // Strip inline YAML comment (e.g. "mock  # comment" → "mock")
  const commentIdx = raw.indexOf(' #');
  return commentIdx >= 0 ? raw.slice(0, commentIdx).trim() : raw;
}

// ── Load all files once ─────────────────────────────────────────────────────

const stagingCompose = readText('docker-compose.staging.yaml');
const prodCompose = readText('docker-compose.prod.yaml');
const stagingYaml = readText('config/staging.yaml');
const prodYaml = readText('config/production.yaml');
const defaultYaml = readText('config/default.yaml');
const stagingCaddy = readText('Caddyfile.staging');
const prodCaddy = readText('Caddyfile.prod');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('staging/production environment invariants', () => {

  // ── 1. NODE_ENV correctness in compose overlays ─────────────────────────

  describe('NODE_ENV in compose overlays', () => {
    it('staging overlay must NOT set NODE_ENV=production', () => {
      expect(stagingCompose).not.toMatch(/NODE_ENV:\s*production/);
    });

    it('production overlay must NOT set NODE_ENV=staging', () => {
      expect(prodCompose).not.toMatch(/NODE_ENV:\s*staging/);
    });

    it('staging overlay sets NODE_ENV=staging for api and worker', () => {
      const matches = stagingCompose.match(/NODE_ENV:\s*staging/g);
      expect(matches?.length).toBeGreaterThanOrEqual(2); // api + worker
    });

    it('production overlay sets NODE_ENV=production for api and worker', () => {
      const matches = prodCompose.match(/NODE_ENV:\s*production/g);
      expect(matches?.length).toBeGreaterThanOrEqual(2); // api + worker
    });
  });

  // ── 2. Billing safety ──────────────────────────────────────────────────

  describe('billing safety defaults', () => {
    it('staging config uses a real billing provider (creem test API), not mock', () => {
      const billingBlock = findYamlBlock(stagingYaml, 'billing');
      expect(blockScalar(billingBlock, 'primaryProvider')).not.toBe('mock');
    });

    it('production config does NOT default billing.primaryProvider to mock', () => {
      const billingBlock = findYamlBlock(prodYaml, 'billing');
      // Production YAML either omits billing entirely or sets a real provider
      if (billingBlock) {
        expect(blockScalar(billingBlock, 'primaryProvider')).not.toBe('mock');
      }
      // If billing block is absent, that's also fine — default.yaml's mock
      // will be caught by the production startup guard.
    });
  });

  // ── 3. Live rollout safety ─────────────────────────────────────────────

  describe('live rollout safety', () => {
    it('staging config has liveRollout disabled', () => {
      const lrBlock = findYamlBlock(stagingYaml, 'liveRollout');
      expect(blockScalar(lrBlock, 'enabled')).toBe('false');
    });
  });

  // ── 4. Alerting safety ─────────────────────────────────────────────────

  describe('alerting safety', () => {
    it('staging config has alerts disabled (inherited from default.yaml via deep merge)', () => {
      // default.yaml sets alerts.enabled: false. staging.yaml may have an
      // alerts block but must not override enabled to true. The runtime
      // deepMerge preserves default keys not present in the overlay.
      const defaultAlerts = findYamlBlock(defaultYaml, 'alerts');
      expect(blockScalar(defaultAlerts, 'enabled')).toBe('false');

      const stagingAlerts = findYamlBlock(stagingYaml, 'alerts');
      // If staging declares an alerts block, it must not set enabled: true
      if (stagingAlerts) {
        expect(blockScalar(stagingAlerts, 'enabled')).not.toBe('true');
      }
    });
  });

  // ── 5. Caddyfile domain isolation ──────────────────────────────────────

  describe('Caddyfile domain isolation', () => {
    it('Caddyfile.staging does NOT reference bare production domains', () => {
      // Strip the email line (admin@openaidom.com) which legitimately
      // references the bare domain — we only care about site blocks.
      const siteBlocks = stagingCaddy.replace(/^\{[^}]*\}/m, '');
      // openaidom.com NOT preceded by "staging."
      expect(siteBlocks).not.toMatch(/(?<!staging\.)openaidom\.com/);
      expect(siteBlocks).not.toMatch(/www\.openaidom\.com/);
      expect(siteBlocks).not.toMatch(/app\.openaidom\.com/);
    });

    it('Caddyfile.prod does NOT reference staging domain', () => {
      expect(prodCaddy).not.toMatch(/staging\.openaidom\.com/);
    });

    it('Caddyfile.staging handles staging.openaidom.com', () => {
      expect(stagingCaddy).toMatch(/staging\.openaidom\.com/);
    });

    it('Caddyfile.prod handles production domain(s)', () => {
      expect(prodCaddy).toMatch(/openaidom\.com/);
    });
  });

  // ── 6. Caddyfile required route blocks ────────────────────────────────
  // Every path that does NOT use the /api prefix MUST have an explicit
  // handle block in the Caddyfile — otherwise it falls through to the
  // SPA catch-all. If you add a new public endpoint without /api/*, add
  // it to this list.

  describe('Caddyfile required route blocks', () => {
    const requiredApiBlocks = [
      '/health',
      '/auth/*',
      '/billing/*',
      '/connections/oauth/*',
      '/telegram/*',
    ];

    for (const block of requiredApiBlocks) {
      it(`Caddyfile.staging has handle for ${block}`, () => {
        const escaped = block.replace(/\*/g, '\\*');
        expect(stagingCaddy).toMatch(new RegExp(`handle\\s+${escaped}`));
      });

      it(`Caddyfile.prod has handle for ${block}`, () => {
        const escaped = block.replace(/\*/g, '\\*');
        expect(prodCaddy).toMatch(new RegExp(`handle\\s+${escaped}`));
      });
    }
  });

  // ── 7. Auth origin consistency ─────────────────────────────────────────

  describe('auth origin consistency in compose overlays', () => {
    it('staging auth origins point to staging domain', () => {
      expect(stagingCompose).toMatch(
        /AUTH_PUBLIC_BASE_URL:\s*https:\/\/staging\.openaidom\.com/,
      );
      expect(stagingCompose).toMatch(
        /AUTH_FRONTEND_ORIGIN:\s*https:\/\/staging\.openaidom\.com/,
      );
    });

    it('production auth origins point to production domain', () => {
      expect(prodCompose).toMatch(
        /AUTH_PUBLIC_BASE_URL:\s*https:\/\/openaidom\.com/,
      );
      expect(prodCompose).toMatch(
        /AUTH_FRONTEND_ORIGIN:\s*https:\/\/openaidom\.com/,
      );
    });
  });

  // ── 7. VITE_API_ORIGIN consistency ─────────────────────────────────────

  describe('VITE_API_ORIGIN consistency', () => {
    it('staging VITE_API_ORIGIN matches staging domain', () => {
      expect(stagingCompose).toMatch(
        /VITE_API_ORIGIN:\s*https:\/\/staging\.openaidom\.com/,
      );
    });

    it('production VITE_API_ORIGIN matches production domain', () => {
      expect(prodCompose).toMatch(
        /VITE_API_ORIGIN:\s*https:\/\/openaidom\.com/,
      );
    });
  });

  // ── 8. Cross-file domain consistency ───────────────────────────────────

  describe('cross-file domain consistency', () => {
    it('staging Caddyfile domain matches staging compose auth origin', () => {
      const caddyMatch = stagingCaddy.match(/(staging\.openaidom\.com)/);
      const authMatch = stagingCompose.match(
        /AUTH_PUBLIC_BASE_URL:\s*https:\/\/([\w.-]+)/,
      );
      expect(caddyMatch?.[1]).toBeTruthy();
      expect(caddyMatch![1]).toBe(authMatch?.[1]);
    });

    it('production Caddyfile domain matches production compose auth origin', () => {
      const caddyDomains = prodCaddy.match(/[\w.-]*openaidom\.com/g) ?? [];
      const authMatch = prodCompose.match(
        /AUTH_PUBLIC_BASE_URL:\s*https:\/\/([\w.-]+)/,
      );
      expect(caddyDomains).toContain(authMatch?.[1]);
    });
  });

  // ── 9. Caddyfile references correct overlay ────────────────────────────

  describe('compose overlay references correct Caddyfile', () => {
    it('staging compose overlay mounts Caddyfile.staging', () => {
      expect(stagingCompose).toMatch(/Caddyfile\.staging/);
    });

    it('production compose overlay mounts Caddyfile.prod', () => {
      expect(prodCompose).toMatch(/Caddyfile\.prod/);
    });
  });

  // ── 10. Caddyfile auth routing completeness ────────────────────────────
  // Bug 2026-07-12/001: missing handle /auth/* caused Google login to silently
  // fail — requests fell through to the SPA catch-all instead of reaching the
  // API's OAuth endpoints.
  //
  // The fix routes /auth/* to the API, but with a critical exception:
  // /auth/callback MUST go to the web container (SPA) because the OAuth
  // callback flow redirects the browser there with an exchange code.  The
  // SPA's AuthCallbackPage reads the code, calls POST /auth/exchange, and
  // completes sign-in.  Without this exception, /auth/callback hits the API
  // (which has no handler for it) and returns 404 — "nothing happens."

  describe('Caddyfile auth routing', () => {
    it('Caddyfile.staging routes /auth/* to the API', () => {
      expect(stagingCaddy).toMatch(
        /handle\s+\/auth\/\*\s*\{\s*\n\s*reverse_proxy\s+api:3000/,
      );
    });

    it('Caddyfile.prod routes /auth/* to the API', () => {
      expect(prodCaddy).toMatch(
        /handle\s+\/auth\/\*\s*\{\s*\n\s*reverse_proxy\s+api:3000/,
      );
    });

    it('Caddyfile.staging routes /auth/callback to the web container (SPA)', () => {
      expect(stagingCaddy).toMatch(
        /handle\s+\/auth\/callback\s*\{\s*\n\s*reverse_proxy\s+web:80/,
      );
    });

    it('Caddyfile.prod routes /auth/callback to the web container (SPA)', () => {
      expect(prodCaddy).toMatch(
        /handle\s+\/auth\/callback\s*\{\s*\n\s*reverse_proxy\s+web:80/,
      );
    });

    it('/auth/callback appears before /auth/* in staging (order matters)', () => {
      const callbackIdx = stagingCaddy.search(/handle\s+\/auth\/callback/);
      const wildcardIdx = stagingCaddy.search(/handle\s+\/auth\/\*/);
      expect(callbackIdx).toBeGreaterThan(0);
      expect(callbackIdx).toBeLessThan(wildcardIdx);
    });

    it('/auth/callback appears before /auth/* in production (order matters)', () => {
      const callbackIdx = prodCaddy.search(/handle\s+\/auth\/callback/);
      const wildcardIdx = prodCaddy.search(/handle\s+\/auth\/\*/);
      expect(callbackIdx).toBeGreaterThan(0);
      expect(callbackIdx).toBeLessThan(wildcardIdx);
    });

    it('Caddyfile.staging auth route appears before the catch-all handle', () => {
      const authIdx = stagingCaddy.search(/handle\s+\/auth\/\*/);
      const catchAllIdx = stagingCaddy.search(/handle\s*\{/);
      expect(authIdx).toBeGreaterThan(0);
      expect(catchAllIdx).toBeGreaterThan(authIdx);
    });

    it('Caddyfile.prod auth route appears before the catch-all handle', () => {
      const authIdx = prodCaddy.search(/handle\s+\/auth\/\*/);
      const catchAllIdx = prodCaddy.search(/handle\s*\{/);
      expect(authIdx).toBeGreaterThan(0);
      expect(catchAllIdx).toBeGreaterThan(authIdx);
    });
  });

  // ── 11. Deploy script reloads Caddy ────────────────────────────────────
  // Bug 2026-07-12/001: Caddy bind-mounts its config file; docker compose
  // up -d does NOT restart containers whose service definitions haven't
  // changed, so Caddyfile-only changes are silently ignored unless the
  // deploy script explicitly reloads/restarts Caddy.

  describe('deploy script restarts Caddy after deployment', () => {
    const pushScript = readText('infra/hetzner/scripts/push.sh');

    it('push.sh restarts the caddy service after docker compose up -d', () => {
      // The restart must come after the up -d and health-check loop
      expect(pushScript).toMatch(/restart\s+caddy/);
    });

    it('push.sh Caddy restart uses the correct compose files', () => {
      // Must use COMPOSE_FILES (or equivalent) so it targets the right env
      const caddyLine = pushScript.match(/^docker compose.*restart caddy/m);
      expect(caddyLine).toBeTruthy();
      // The line must reference the compose file variables, not hard-coded paths
      expect(caddyLine![0]).toMatch(/\$\{?COMPOSE_FILES\}?/);
    });

    // Bug 2026-07-18/003: maintenance-restart.sh's main deploy path (Step 3)
    // was missing the same `restart caddy` step, letting a stale bind-mounted
    // Caddyfile keep running on staging after a maintenance-window redeploy.
    // The script also has a second "restart caddy" line inside
    // rollback_on_failure() — scope the assertions to the Step 3 block only,
    // so this test targets the main deploy path rather than any occurrence.
    const maintenanceScript = readText('infra/hetzner/scripts/maintenance-restart.sh');
    const maintenanceStep3Block =
      maintenanceScript.match(/Step 3 — Deploying latest code[\s\S]*?(?=# ─── Step 4)/)?.[0] ?? '';

    it('maintenance-restart.sh restarts the caddy service after docker compose up -d in the main deploy path (Step 3)', () => {
      expect(maintenanceStep3Block).toMatch(/restart\s+caddy/);
    });

    it('maintenance-restart.sh Step 3 Caddy restart uses the correct compose files', () => {
      // The line is indented (nested inside an `if` block), unlike push.sh's
      // top-level invocation, so allow leading whitespace before the command.
      const caddyLine = maintenanceStep3Block.match(/^\s*docker compose.*restart caddy/m);
      expect(caddyLine).toBeTruthy();
      // The line must reference the compose file variables, not hard-coded paths
      expect(caddyLine![0]).toMatch(/\$\{?COMPOSE_FILES\}?/);
    });
  });

  // ── 12. web nginx config Cache-Control headers ─────────────────────────
  // Bug 2026-07-18/004: docker/nginx.conf (served by the `web` container in
  // production/staging) previously set no Cache-Control headers at all,
  // letting browsers heuristically cache index.html (the SPA's
  // non-content-hashed entry point) indefinitely — users kept running a
  // stale JS bundle after a deploy.
  // See docs/bug-reports/2026/07/18/004-gmail-oauth-stale-cached-spa-bundle.md.

  describe('web nginx config sets correct Cache-Control headers', () => {
    const nginxConf = readText('docker/nginx.conf');

    const assetsBlock = nginxConf.match(/location\s+\/assets\/\s*\{[^}]*\}/)?.[0] ?? '';
    const spaBlock = nginxConf.match(/location\s+\/\s*\{\s*\n\s*try_files\s+\$uri\s+\$uri\/\s+\/index\.html;[^}]*\}/)?.[0] ?? '';

    it('the /assets/ location block exists and caches immutably with a long max-age', () => {
      expect(assetsBlock).toBeTruthy();
      expect(assetsBlock).toMatch(/Cache-Control/);
      expect(assetsBlock).toMatch(/immutable/);
      expect(assetsBlock).toMatch(/max-age=31536000/);
    });

    it('the SPA fallback location (/) block never lets index.html be cached', () => {
      expect(spaBlock).toBeTruthy();
      expect(spaBlock).toMatch(/Cache-Control\s+"(no-cache|no-store)"/);
    });

    it('the /assets/ and SPA fallback Cache-Control values are differentiated', () => {
      expect(assetsBlock).not.toMatch(/Cache-Control\s+"no-cache"/);
      expect(spaBlock).not.toMatch(/immutable/);
    });
  });
});

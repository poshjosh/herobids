import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REQUIRED_ENTRY_IDS = new Set([
  'agent-risk-defaults', 'strategy-preset-economy', 'strategy-preset-premium', 'strategy-preset-standard',
  'watch-types', 'scan-types', 'tick-gates-session-hours',
  'domain-agent-risk-contract', 'domain-config-presets-loader', 'domain-config-presets', 'domain-config-strategy-parameters',
  'domain-cost-profile', 'domain-market-assessment', 'domain-models-decision', 'domain-pagination',
  'domain-ports-candle-fetcher', 'domain-ports-economic-calendar', 'domain-ports-mark-source', 'domain-ports-sentiment',
  'domain-ports-strategy', 'domain-ports-subscription', 'domain-ports-swap-venue', 'domain-ports-token-safety',
  'domain-ports-venue', 'domain-result', 'domain-scanner-types', 'domain-trading-actor-health',
  'domain-trading-execution-capability', 'domain-trading-mode-rank', 'domain-trading-trading-protocol',
  'domain-trading-venue-capability', 'domain-values-ids', 'domain-values-index', 'domain-values-instrument', 'domain-values-money',
]);

export const REQUIRED_ENTRY_AUTHORITIES = Object.freeze({
  'agent-risk-defaults': 'traderton',
  'strategy-preset-economy': 'mirror-only',
  'strategy-preset-premium': 'mirror-only',
  'strategy-preset-standard': 'mirror-only',
  'watch-types': 'mirror-only',
  'scan-types': 'mirror-only',
  'tick-gates-session-hours': 'mirror-only',
  'domain-agent-risk-contract': 'traderton',
  'domain-config-presets-loader': 'mirror-only',
  'domain-config-presets': 'mirror-only',
  'domain-config-strategy-parameters': 'mirror-only',
  'domain-cost-profile': 'mirror-only',
  'domain-market-assessment': 'mirror-only',
  'domain-models-decision': 'mirror-only',
  'domain-pagination': 'mirror-only',
  'domain-ports-candle-fetcher': 'mirror-only',
  'domain-ports-economic-calendar': 'mirror-only',
  'domain-ports-mark-source': 'mirror-only',
  'domain-ports-sentiment': 'mirror-only',
  'domain-ports-strategy': 'mirror-only',
  'domain-ports-subscription': 'mirror-only',
  'domain-ports-swap-venue': 'mirror-only',
  'domain-ports-token-safety': 'mirror-only',
  'domain-ports-venue': 'mirror-only',
  'domain-result': 'mirror-only',
  'domain-scanner-types': 'mirror-only',
  'domain-trading-actor-health': 'mirror-only',
  'domain-trading-execution-capability': 'mirror-only',
  'domain-trading-mode-rank': 'mirror-only',
  'domain-trading-trading-protocol': 'mirror-only',
  'domain-trading-venue-capability': 'mirror-only',
  'domain-values-ids': 'mirror-only',
  'domain-values-index': 'mirror-only',
  'domain-values-instrument': 'mirror-only',
  'domain-values-money': 'mirror-only',
});

function extractRegion(content, region) {
  if (!region) return content;
  if (region.topLevelKey) {
    const lines = content.split(/\r?\n/);
    const start = lines.findIndex((line) => line === `${region.topLevelKey}:`);
    if (start < 0) throw new Error(`missing YAML key ${region.topLevelKey}`);
    const end = lines.findIndex((line, index) => index > start && /^[A-Za-z0-9_]+:/.test(line));
    return lines.slice(start, end < 0 ? undefined : end).join('\n');
  }
  const start = content.indexOf(region.start);
  const end = region.end ? content.indexOf(region.end, start + region.start.length) : content.length;
  if (start < 0 || end < 0) throw new Error(`missing declared region ${region.start}..${region.end ?? 'EOF'}`);
  return content.slice(start, end);
}

function normalize(content, normalization) {
  let normalized = content.replace(/\r\n/g, '\n');
  if (normalization === 'line-endings') return normalized;
  if (normalization === 'yaml-top-level-block-without-comments-and-blank-lines') {
    return normalized.split('\n').map((line) => line.replace(/\s+#.*$/, '').trimEnd()).filter((line) => line && !line.trimStart().startsWith('#')).join('\n').replace(/\s+/g, '');
  }
  if (normalization === 'namespace-herobids-to-traderton') return normalized.replaceAll('@herobids/', '@traderton/');
  if (normalization === 'typescript-no-comments-no-whitespace-with-namespace') {
    return normalized.replaceAll('@herobids/', '@traderton/').replaceAll('./runtime-composition.js', './scan-types.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\s+/g, '').replace(/=\|/g, '=');
  }
  throw new Error(`unknown normalization ${normalization}`);
}

function validateManifest(manifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error('manifest must be version 1 with entries');
  const ids = new Set(manifest.entries.map((entry) => entry.id));
  if (ids.size !== manifest.entries.length) throw new Error('manifest has duplicate entry ids');
  for (const id of REQUIRED_ENTRY_IDS) if (!ids.has(id)) throw new Error(`manifest missing required entry ${id}`);
  for (const [id, authority] of Object.entries(REQUIRED_ENTRY_AUTHORITIES)) {
    const entry = manifest.entries.find((candidate) => candidate.id === id);
    if (entry?.authority !== authority) throw new Error(`manifest entry ${id} must have authority ${authority}`);
  }
}

export function checkParity({ herobidsRoot, tradertonRoot, manifestPath, protectedMode }) {
  if (!existsSync(herobidsRoot) || !existsSync(tradertonRoot)) {
    return protectedMode ? { status: 'FAILED', errors: ['sibling checkout is missing'] } : { status: 'SKIPPED', errors: [] };
  }
  if (!existsSync(manifestPath)) return { status: 'FAILED', errors: ['parity manifest is missing'] };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    validateManifest(manifest);
  } catch (error) {
    return { status: 'FAILED', errors: [error instanceof Error ? error.message : String(error)] };
  }
  const errors = [];
  for (const entry of manifest.entries) {
    try {
      const leftPath = resolve(herobidsRoot, entry.herobids.path);
      const rightPath = resolve(tradertonRoot, entry.traderton.path);
      if (!existsSync(leftPath) || !existsSync(rightPath)) throw new Error('declared path is missing');
      const left = normalize(extractRegion(readFileSync(leftPath, 'utf8'), entry.herobids.region), entry.normalization);
      const right = normalize(extractRegion(readFileSync(rightPath, 'utf8'), entry.traderton.region), entry.normalization);
      if (left !== right) throw new Error('normalized content differs');
    } catch (error) {
      errors.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors.length === 0 ? { status: 'PASSED', errors } : { status: 'FAILED', errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(new URL('.', import.meta.url).pathname, '..');
  const result = checkParity({
    herobidsRoot: process.env.HEROBIDS_ROOT ?? root,
    tradertonRoot: process.env.TRADERTON_ROOT ?? resolve(root, '..', 'traderton'),
    manifestPath: process.env.PARITY_MANIFEST ?? resolve(root, 'scripts/parity-drift-manifest.json'),
    protectedMode: process.env.PARITY_DRIFT_CI === '1',
  });
  console.log(`parity-drift: ${result.status}`);
  for (const error of result.errors) console.error(`parity-drift: ${error}`);
  process.exitCode = result.status === 'FAILED' ? 1 : 0;
}
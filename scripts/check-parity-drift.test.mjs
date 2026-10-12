import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkParity } from './check-parity-drift.mjs';

const temporaryRoots = [];
function cleanup() {
  temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'parity-drift-'));
  temporaryRoots.push(root);
  const herobidsRoot = join(root, 'herobids');
  const tradertonRoot = join(root, 'traderton');
  const manifestPath = join(root, 'manifest.json');
  for (const directory of [herobidsRoot, tradertonRoot]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'source.ts'), 'export const value = 1;');
  }
  // The manifest is now empty (zero entries — the parity-drift check is being
  // retired). Use a hardcoded test entry so the checker's drift detection is
  // still exercised; `validateManifest` accepts any unique-id manifest now that
  // `REQUIRED_ENTRY_IDS` is empty.
  const entries = [{ id: 'test-entry', authority: 'mirror-only', normalization: 'line-endings', herobids: { path: 'source.ts' }, traderton: { path: 'source.ts' } }];
  writeFileSync(manifestPath, JSON.stringify({ version: 1, entries }));
  return { herobidsRoot, tradertonRoot, manifestPath };
}

test('detects normalized content drift', () => {
  try {
    const paths = fixture();
    writeFileSync(join(paths.tradertonRoot, 'source.ts'), 'export const value = 2;');
    assert.equal(checkParity({ ...paths, protectedMode: false }).status, 'FAILED');
  } finally {
    cleanup();
  }
});

test('skips a missing sibling locally and fails closed in protected mode', () => {
  try {
    const paths = fixture();
    rmSync(paths.tradertonRoot, { recursive: true, force: true });
    assert.equal(checkParity({ ...paths, protectedMode: false }).status, 'SKIPPED');
    assert.equal(checkParity({ ...paths, protectedMode: true }).status, 'FAILED');
  } finally {
    cleanup();
  }
});
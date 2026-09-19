import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { TradingProfileConnection } from './trading-profile-reconciliation.js';

const apiSourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const profileSnapshotProperties = ['actorId', 'venueAccountId', 'capital', 'riskPosture', 'executionDefaults'];

const activeBindingMutators = [
  { path: 'routes/agents.ts', reconciliationCalls: 4 },
  { path: 'routes/chat.ts', reconciliationCalls: 2 },
  { path: 'routes/connections.ts', reconciliationCalls: 1 },
  { path: 'services/agent-config-service.ts', reconciliationCalls: 2 },
  { path: 'services/agent-go-live-service.ts', reconciliationCalls: 1 },
] as const;

const revokedOnlyMutators = [
  { path: 'provider-links.ts', status: 'revoked' },
] as const;

const workflowBehaviorTests = [
  'routes/agents.test.ts',
  'routes/agent-interactivity.test.ts',
  'routes/chat.test.ts',
  'routes/connections.test.ts',
  'services/agent-config-service.test.ts',
  'services/agent-go-live-service.test.ts',
  'services/agent-instantiation-service.test.ts',
] as const;
function connection(overrides: Partial<TradingProfileConnection>): TradingProfileConnection {
  return {
    connectionId: 'connection-1',
    venueAccountId: 'venue-account-1',
    active: true,
    ready: true,
    isDefault: false,
    ...overrides,
  };
}

async function source(relativePath: string): Promise<string> {
  return readFile(join(apiSourceRoot, relativePath), 'utf8');
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  }));
  return files.flat();
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null;
}

function hasProfileSnapshotLiteral(contents: string): boolean {
  const sourceFile = ts.createSourceFile('source.ts', contents, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Set(node.properties.flatMap((property) => (
        'name' in property && property.name ? [propertyName(property.name)].filter(Boolean) : []
      )));
      if (profileSnapshotProperties.every((property) => properties.has(property))) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function hasSelectedBindingComputation(contents: string): boolean {
  const sourceFile = ts.createSourceFile('source.ts', contents, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'find') {
      let enclosingFunction: ts.Node | undefined = node;
      while (enclosingFunction && !ts.isFunctionLike(enclosingFunction)) {
        enclosingFunction = enclosingFunction.parent;
      }
      const functionText = enclosingFunction?.getText(sourceFile) ?? '';
      if (/\.active\s*&&\s*\w+\.ready/.test(functionText)
        && /\.venueAccountId\s*!==\s*null/.test(functionText)
        && /\.isDefault/.test(functionText)
        && /connectionId:/.test(functionText)
        && /venueAccountId:/.test(functionText)) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function countReconciliationCalls(contents: string): number {
  const sourceFile = ts.createSourceFile('source.ts', contents, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'reconcileTradingProfile') {
      count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

describe('trading profile workflow delegation', () => {
  it('exercises the reconciliation seam in behavior tests for every C1a workflow', async () => {
    const testSources = await Promise.all(workflowBehaviorTests.map(async (path) => ({ path, contents: await source(path) })));

    for (const { path, contents } of testSources) {
      expect(contents, path).toMatch(/(?:mock\.calls|toHaveBeenCalled)(?:\[|\(|With)/);
      expect(contents, path).toContain('reconcileTradingProfile');
    }
  });

  it('permits profile-shaped snapshots and selected-binding ranking only in the helper', async () => {
    const files = await sourceFiles(apiSourceRoot);
    const productionSources = await Promise.all(files.map(async (path) => ({
      path: path.slice(apiSourceRoot.length + 1),
      contents: await readFile(path, 'utf8'),
    })));

    expect(productionSources.filter(({ contents }) => hasProfileSnapshotLiteral(contents)).map(({ path }) => path).sort())
      .toEqual(['agents/trading-profile-reconciliation.ts']);
    expect(productionSources.filter(({ contents }) => hasSelectedBindingComputation(contents)).map(({ path }) => path).sort())
      .toEqual(['agents/trading-profile-reconciliation.ts']);
  });

  it('requires every active binding mutation site to delegate and documents revoked-only cleanup', async () => {
    const files = await sourceFiles(apiSourceRoot);
    const productionSources = await Promise.all(files.map(async (path) => ({
      path: path.slice(apiSourceRoot.length + 1),
      contents: await readFile(path, 'utf8'),
    })));
    const mutationFiles = productionSources
      .filter(({ contents }) => /(?:insert|update|delete)\(agentConnections\)/.test(contents))
      .map(({ path }) => path)
      .sort();

    expect(mutationFiles).toEqual([
      ...activeBindingMutators.map(({ path }) => path),
      ...revokedOnlyMutators.map(({ path }) => path),
    ].sort());
    for (const { path, reconciliationCalls } of activeBindingMutators) {
      const contents = productionSources.find((sourceFile) => sourceFile.path === path)?.contents;
      expect(contents, path).toBeDefined();
      expect(countReconciliationCalls(contents!), path).toBe(reconciliationCalls);
    }
    for (const { path, status } of revokedOnlyMutators) {
      const contents = productionSources.find((sourceFile) => sourceFile.path === path)?.contents;
      expect(contents, path).toBeDefined();
      expect(contents).toMatch(new RegExp(`delete\\(agentConnections\\)[\\s\\S]{0,300}status, '${status}'`));
      expect(contents).not.toMatch(/(?:insert|update)\(agentConnections\)/);
    }
  });
});
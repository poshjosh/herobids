import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ── Paths ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const TECHNICAL_GLOSSARY = resolve(ROOT, 'docs/tech/glossary.md');
const PUBLIC_GLOSSARY = resolve(
  ROOT,
  'apps/web/src/features/public-pages/content/docs/reference/glossary.md',
);

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize a term heading for comparison:
 * - Lowercase
 * - Strip backtick code formatting
 * - Strip parenthetical aliases like "Bot Run (Bot Session)"
 * - Collapse whitespace
 */
function normalizeTerm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract term headings from the technical glossary.
 * Technical glossary uses `### Term` under `## A`, `## B`, etc. letter sections.
 * Only `###` headings are terms; `##` headings are letter section markers.
 */
function extractTechnicalTerms(markdown: string): Set<string> {
  const terms = new Set<string>();
  for (const [, term] of markdown.matchAll(/^### (.+)$/gm)) {
    terms.add(normalizeTerm(term!));
  }
  return terms;
}

/**
 * Extract term headings from the public glossary.
 * Public glossary uses `## Term` directly (no letter sections).
 * The first `## Glossary` heading is the title and is excluded.
 */
function extractPublicTerms(markdown: string): Set<string> {
  const terms = new Set<string>();
  for (const [, term] of markdown.matchAll(/^## (.+)$/gm)) {
    if (term === 'Glossary') continue;
    terms.add(normalizeTerm(term!));
  }
  return terms;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('glossary sync', () => {
  let technicalTerms: Set<string>;
  let publicTerms: Set<string>;

  beforeAll(() => {
    const techMd = readFileSync(TECHNICAL_GLOSSARY, 'utf-8');
    const publicMd = readFileSync(PUBLIC_GLOSSARY, 'utf-8');
    technicalTerms = extractTechnicalTerms(techMd);
    publicTerms = extractPublicTerms(publicMd);
  });

  it('every public glossary term must exist in the technical glossary', () => {
    const missing: string[] = [];
    for (const term of publicTerms) {
      if (!technicalTerms.has(term)) {
        missing.push(term);
      }
    }

    if (missing.length > 0) {
      missing.sort();
      throw new Error(
        `Public glossary terms missing from technical glossary (docs/tech/glossary.md):\n` +
          missing.map((t) => `  - "${t}"`).join('\n') +
          `\n\nAdd these terms to docs/tech/glossary.md or remove them from the public glossary.` +
          `\nThe technical glossary is the single source of truth for all platform terminology.`,
      );
    }
  });

  it('technical glossary has no empty letter sections', () => {
    const techMd = readFileSync(TECHNICAL_GLOSSARY, 'utf-8');
    const sections = techMd.split(/^## [A-Z]$/gm);

    for (let i = 1; i < sections.length; i++) {
      const section = sections[i]!;
      if (!/^### /m.test(section)) {
        const letters = [...techMd.matchAll(/^## ([A-Z])$/gm)];
        const letter = letters[i - 1]?.[1] ?? '?';
        throw new Error(
          `Empty letter section "## ${letter}" in technical glossary (docs/tech/glossary.md). ` +
            `Each letter section must contain at least one term.`,
        );
      }
    }
  });
});

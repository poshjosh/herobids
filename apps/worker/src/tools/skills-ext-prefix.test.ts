import { describe, it, expect } from 'vitest';
import { normalizeExternalRef } from './skills.js';

// Bug condition exploration (Property 1): the `ext:` UI id prefix must never reach the skills CLI.
// Table-driven over generated (owner, repo, skill) triples; no property-testing library.

const OWNERS = ['openaidom', 'o', 'acme-labs'];
const REPOS = ['skills', 'r', 'tools'];
const SKILL_NAMES = ['job-search', 's', 'x1'];
const TRIPLES = OWNERS.flatMap((owner) =>
  REPOS.flatMap((repo) => SKILL_NAMES.map((skill) => ({ owner, repo, skill }))),
);

describe('normalizeExternalRef with the ext: UI prefix', () => {
  it('rewrites ext:o/r/s to the CLI form o/r@s', () => {
    expect(normalizeExternalRef('ext:o/r/s').ref).toBe('o/r@s');
  });

  it.each(TRIPLES)('rewrites ext:$owner/$repo/$skill to $owner/$repo@$skill', ({ owner, repo, skill }) => {
    const result = normalizeExternalRef(`ext:${owner}/${repo}/${skill}`);

    expect(result.ref).toBe(`${owner}/${repo}@${skill}`);
    expect(result.wasNormalized).toBe(true);
  });

  it.each(TRIPLES)('strips the prefix from ext:$owner/$repo@$skill', ({ owner, repo, skill }) => {
    expect(normalizeExternalRef(`ext:${owner}/${repo}@${skill}`).ref).toBe(`${owner}/${repo}@${skill}`);
  });
});

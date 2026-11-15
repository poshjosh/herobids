import { describe, it, expect } from 'vitest';
import { normalizeExternalRef } from './skills.js';

// Preservation (Property 4): refs without the `ext:` UI prefix are normalized exactly as before.
// Table-driven over generated (owner, repo, skill) triples; no property-testing library.

const OWNERS = ['openaidom', 'o', 'acme-labs'];
const REPOS = ['skills', 'r', 'tools'];
const SKILL_NAMES = ['job-search', 's', 'x1'];
const TRIPLES = OWNERS.flatMap((owner) =>
  REPOS.flatMap((repo) => SKILL_NAMES.map((skill) => ({ owner, repo, skill }))),
);

describe('preservation: normalizeExternalRef for non-prefixed refs', () => {
  it('rewrites o/r/s to the CLI form o/r@s', () => {
    expect(normalizeExternalRef('o/r/s')).toEqual({ ref: 'o/r@s', wasNormalized: true });
  });

  it.each(TRIPLES)('rewrites $owner/$repo/$skill to $owner/$repo@$skill', ({ owner, repo, skill }) => {
    expect(normalizeExternalRef(`${owner}/${repo}/${skill}`)).toEqual({
      ref: `${owner}/${repo}@${skill}`,
      wasNormalized: true,
    });
  });

  it.each(TRIPLES)('leaves the CLI form $owner/$repo@$skill unchanged', ({ owner, repo, skill }) => {
    const ref = `${owner}/${repo}@${skill}`;
    expect(normalizeExternalRef(ref)).toEqual({ ref, wasNormalized: false });
  });

  it.each(['author/name', 'system/programming', 'foo', 'a/b/c/d', 'ext:foo', 'ext:', 'ext_5ed356e3a5c0385824eb9fbf'])(
    'leaves %s unchanged',
    (ref) => {
      expect(normalizeExternalRef(ref)).toEqual({ ref, wasNormalized: false });
    },
  );
});

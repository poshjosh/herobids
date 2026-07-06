import { describe, it, expect } from 'vitest';
import { EVIDENCE_ARTIFACTS_FOR_REDACTION } from './run-evaluation.js';

describe('EVIDENCE_ARTIFACTS_FOR_REDACTION', () => {
  it('includes unified-agent-config.json for redaction coverage', () => {
    expect(EVIDENCE_ARTIFACTS_FOR_REDACTION).toContain('unified-agent-config.json' as (typeof EVIDENCE_ARTIFACTS_FOR_REDACTION)[number]);
  });

  it('contains the expected core evidence artifacts', () => {
    const expected = [
      'fills.json',
      'journal.json',
      'sessions.json',
      'positions.json',
      'agent-metadata.json',
      'unified-agent-config.json',
    ] as const;

    expect(EVIDENCE_ARTIFACTS_FOR_REDACTION).toEqual(expected);
  });

  it('has exactly 6 artifacts (no regression)', () => {
    expect(EVIDENCE_ARTIFACTS_FOR_REDACTION).toHaveLength(6);
  });

  it('is a readonly tuple for type safety', () => {
    // Verify it's readonly: spreading produces the same type
    const copy: readonly string[] = [...EVIDENCE_ARTIFACTS_FOR_REDACTION];
    expect(copy).toEqual(EVIDENCE_ARTIFACTS_FOR_REDACTION);
  });
});

/**
 * Regression test for bug 2026-06-04-001 — Drizzle migrations skipped when
 * journal `when` timestamps are not strictly ascending.
 *
 * Root cause: drizzle-kit `migrate` skips any journal entry whose `when` value
 * is less than or equal to the maximum `created_at` already in the tracking
 * table.  Hand-editing `_journal.json` without using `drizzle-kit generate` can
 * accidentally introduce an entry with a `when` that falls before the previous
 * entry's timestamp, causing the migration to be silently skipped.
 *
 * The fix for the original instance corrected two entries (0014_agent_protocol
 * and 0015_agent_mvp_communication) that had past-dated timestamps.  A second
 * instance of the same pattern (0004_features_016_017) was found and corrected
 * alongside this test.
 *
 * Invariant: every journal entry MUST have a `when` value strictly greater than
 * the previous entry's `when` value.  This test enforces that invariant so any
 * future manual edit of `_journal.json` is caught immediately.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface DrizzleJournal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

const journalPath = resolve(
  new URL(import.meta.url).pathname,
  '../../drizzle/meta/_journal.json',
);

describe('drizzle migration journal', () => {
  let journal: DrizzleJournal;

  it('journal file parses as valid JSON', () => {
    const raw = readFileSync(journalPath, 'utf8');
    journal = JSON.parse(raw) as DrizzleJournal;
    expect(journal.entries).toBeDefined();
    expect(Array.isArray(journal.entries)).toBe(true);
  });

  it('entries are ordered by idx with no gaps', () => {
    const raw = readFileSync(journalPath, 'utf8');
    journal = JSON.parse(raw) as DrizzleJournal;
    journal.entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
    });
  });

  // Bug-001 regression: every entry's `when` must be strictly greater than the
  // previous entry's `when`.  If any entry has a stale/hand-edited timestamp
  // that is earlier than its predecessor, drizzle will silently skip it on a
  // fresh install, leaving the schema incomplete.
  it('entry `when` timestamps are strictly ascending (bug-001 regression)', () => {
    const raw = readFileSync(journalPath, 'utf8');
    journal = JSON.parse(raw) as DrizzleJournal;

    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]!;
      const curr = journal.entries[i]!;
      expect(curr.when).toBeGreaterThan(prev.when);
    }
  });

  it('all `when` values are positive integers', () => {
    const raw = readFileSync(journalPath, 'utf8');
    journal = JSON.parse(raw) as DrizzleJournal;
    journal.entries.forEach((entry) => {
      expect(typeof entry.when).toBe('number');
      expect(Number.isInteger(entry.when)).toBe(true);
      expect(entry.when).toBeGreaterThan(0);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { describeCutResult } from './stale-result-hints.js';

describe('describeCutResult', () => {
  it.each(['read_file', 'read_file_lines'])('adds the re-read hint with the path from the %s call', (toolName) => {
    const hint = describeCutResult({ toolName, args: { path: 'data/jobs.json' }, originalContent: '{}' });
    expect(hint).toContain('read_file_lines(path: "data/jobs.json", startLine: 1, limit: 200)');
    expect(hint).toContain('read_file(path: "data/jobs.json")');
  });

  it('gives no hint when the call had no usable path', () => {
    expect(describeCutResult({ toolName: 'read_file', args: {}, originalContent: '{}' })).toBeUndefined();
    expect(describeCutResult({ toolName: 'read_file', args: { path: 5 }, originalContent: '{}' })).toBeUndefined();
  });

  it('gives no hint for tools without a cheap re-read', () => {
    expect(describeCutResult({ toolName: 'list_positions', args: { path: 'a' }, originalContent: '{}' })).toBeUndefined();
    expect(describeCutResult({ toolName: undefined, args: {}, originalContent: '{}' })).toBeUndefined();
  });
});

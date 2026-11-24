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

  it('adds the browse_url hint only when the page was saved', () => {
    const saved = JSON.stringify({ url: 'https://a.example', savedTo: 'web-cache/a.example-abc.txt', content: 'x' });
    const hint = describeCutResult({ toolName: 'browse_url', args: { url: 'https://a.example' }, originalContent: saved });
    expect(hint).toContain('web-cache/a.example-abc.txt');
    expect(hint).toContain('read_file_lines(path: "web-cache/a.example-abc.txt", startLine: 1, limit: 200)');
    expect(describeCutResult({ toolName: 'browse_url', args: {}, originalContent: JSON.stringify({ url: 'https://a.example' }) })).toBeUndefined();
  });

  it('gives no browse_url hint when the old result is not JSON', () => {
    expect(describeCutResult({ toolName: 'browse_url', args: {}, originalContent: 'browse_url failed: x' })).toBeUndefined();
  });

  it('adds the list_agent_documents hint to list the document IDs again', () => {
    expect(describeCutResult({ toolName: 'list_agent_documents', args: {}, originalContent: '[]' }))
      .toBe('Call list_agent_documents again to see the full list of document IDs.');
  });
});

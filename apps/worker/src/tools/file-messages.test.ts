import { describe, expect, it } from 'vitest';
import type { ToolResult } from '@herobids/domain';
import * as messages from './file-messages.js';
import { findSignatureProblems } from './tool-signature.js';
import type { QuotaFailure } from './workspace-quota.js';

const MIB = 1024 * 1024;
// About 200 characters, a realistic deeply nested path.
const LONG_PATH = `${'deeply/nested/folder/'.repeat(9)}file-with-a-long-name.json`;
const CONTAINER_ROOT = '/workspace';

const quotaFailure: QuotaFailure = {
  code: 'file.quota_exceeded',
  reason: 'over_quota',
  usedBytes: 100 * MIB,
  quotaBytes: 100 * MIB,
  addBytes: 10,
  walkMaxFiles: 2000,
  topDirs: [
    { name: 'data', bytes: 60 * MIB },
    { name: 'logs', bytes: 30 * MIB },
    { name: 'notes', bytes: 5 * MIB },
    { name: 'misc', bytes: MIB },
  ],
};

interface Case {
  name: string;
  code: string;
  result: ToolResult;
  contains: string[];
}

const cases: Case[] = [
  { name: 'pathInvalid', code: 'file.path_invalid', result: messages.pathInvalid('../x'), contains: ['list_files(path: "")'] },
  { name: 'reservedPath', code: 'file.reserved_path', result: messages.reservedPath(), contains: ['sandbox'] },
  { name: 'reservedDeletePath', code: 'file.reserved_path', result: messages.reservedDeletePath('agent'), contains: ['agent'] },
  { name: 'notFound', code: 'file.not_found', result: messages.notFound('notes/a.txt'), contains: ['list_files(path: "notes")', 'search_files('] },
  { name: 'isDirectory', code: 'file.is_directory', result: messages.isDirectory('notes'), contains: ['list_files(path: "notes")'] },
  { name: 'deleteTooMany', code: 'file.delete_too_many', result: messages.deleteTooMany('big', 5000), contains: ['more than 5000', 'recursive: true'] },
  { name: 'notAFile', code: 'file.not_a_file', result: messages.notAFile('pipe'), contains: ['pipe'] },
  { name: 'tooLarge', code: 'file.too_large', result: messages.tooLarge('big.json', 11 * MIB, 10 * MIB), contains: ['11 MiB', '10 MiB', 'read_file_lines(path, startLine, limit)', 'search_files('] },
  { name: 'writeTooLarge', code: 'file.write_too_large', result: messages.writeTooLarge('big.json', 12 * MIB, 10 * MIB), contains: ['12 MiB', 'append_file(path, content)'] },
  { name: 'contentTooLong append', code: 'file.content_too_long', result: messages.contentTooLong(20_000, 16_000, 'append_file'), contains: ['20000', '16000', 'append_file('] },
  { name: 'contentTooLong write', code: 'file.content_too_long', result: messages.contentTooLong(20_000, 16_000, 'write_file'), contains: ['write_file(path, content)', 'append_file('] },
  { name: 'limitTooLarge', code: 'file.limit_too_large', result: messages.limitTooLarge('limit', 600_000, 500_000), contains: ['600000', '500000', 'read_file_lines(', 'search_files('] },
  { name: 'quotaExceeded', code: 'file.quota_exceeded', result: messages.quotaExceeded(quotaFailure), contains: ['100 of 100 MiB', 'data/ 60 MiB', 'delete_file(path: "data", recursive: true)', 'stat_file(path)'] },
  { name: 'quotaExceeded walk cap', code: 'file.quota_exceeded', result: messages.quotaExceeded({ ...quotaFailure, reason: 'walk_capped' }), contains: ['2000', 'delete_file(path: "data", recursive: true)'] },
  { name: 'editTextNotFound', code: 'edit.text_not_found', result: messages.editTextNotFound('a.txt'), contains: ['read_file_lines(', 'search_files('] },
  { name: 'editAmbiguousMatch', code: 'edit.ambiguous_match', result: messages.editAmbiguousMatch('a.txt', 3), contains: ['3 places', 'replaceAll: true', 'search_files('] },
  { name: 'editNoChange', code: 'edit.no_change', result: messages.editNoChange(), contains: ['same'] },
  { name: 'invalidPattern', code: 'search.invalid_pattern', result: messages.invalidPattern('Unterminated group'), contains: ['Unterminated group', 'regex: false'] },
  { name: 'ioError', code: 'file.io_error', result: messages.ioError('writing', 'a.txt', 'EIO'), contains: ['EIO', 'Do not retry'] },
  { name: 'permissionDenied', code: 'file.permission_denied', result: messages.permissionDenied('a.txt'), contains: ['stat_file(path)'] },
];

describe('file messages', () => {
  it.each(cases)('$name sets $code and names the numbers and the next call', ({ code, result, contains }) => {
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(code);
    for (const text of contains) expect(result.error).toContain(text);
    expect(findSignatureProblems(result.error ?? '')).toEqual([]);
  });

  it('keeps every message under 350 characters excluding the agent path, which is always shown in full', () => {
    const longCases: ToolResult[] = [
      messages.pathInvalid(LONG_PATH),
      messages.notFound(LONG_PATH),
      messages.isDirectory(LONG_PATH, { forDelete: true }),
      messages.deleteTooMany(LONG_PATH, 5000),
      messages.notAFile(LONG_PATH),
      messages.tooLarge(LONG_PATH, 11 * MIB, 10 * MIB),
      messages.writeTooLarge(LONG_PATH, 12 * MIB, 10 * MIB),
      messages.editTextNotFound(LONG_PATH, { crlfMismatch: true }),
      messages.editAmbiguousMatch(LONG_PATH, 12),
      messages.ioError('writing', LONG_PATH, 'ENOSPC'),
      messages.permissionDenied(LONG_PATH),
      messages.quotaExceeded(quotaFailure),
      messages.quotaExceeded({ ...quotaFailure, reason: 'walk_capped' }),
    ];
    const parent = LONG_PATH.slice(0, LONG_PATH.lastIndexOf('/'));
    for (const result of longCases) {
      const error = result.error!;
      // The agent's own path (and its folder, used in list_files examples) does not count toward the cap.
      const withoutPath = error.split(LONG_PATH).join('').split(parent).join('');
      expect(withoutPath.length, error).toBeLessThanOrEqual(350);
      expect(error).not.toContain(CONTAINER_ROOT);
      // Call examples must stay callable: a message that names the path never shortens it.
      if (error.includes('deeply')) expect(error).toContain(LONG_PATH.split('/')[0]!);
      expect(error).not.toContain('…');
    }
  });

  it('classifies EIO and ENOSPC as platform faults', () => {
    for (const errno of ['EIO', 'ENOSPC']) {
      const result = messages.fromFsError(Object.assign(new Error('x'), { code: errno }), { action: 'writing', path: 'a.txt' });
      expect(result).toMatchObject({ errorCode: 'file.io_error', errorOwner: 'platform', fault: true, retryable: false });
      expect(result.error).toContain('Do not retry');
    }
  });

  it('classifies EACCES as an agent-owned, non-fault error', () => {
    const result = messages.fromFsError(Object.assign(new Error('x'), { code: 'EACCES' }), { action: 'reading', path: 'a.txt' });
    expect(result).toMatchObject({ errorCode: 'file.permission_denied', errorOwner: 'agent', fault: false });
  });

  it('maps ENOENT to file.not_found and unknown errors to a non-fault failure', () => {
    expect(messages.fromFsError(Object.assign(new Error('x'), { code: 'ENOENT' }), { action: 'reading', path: 'a.txt' }).errorCode)
      .toBe('file.not_found');
    const other = messages.fromFsError(new Error('boom'), { action: 'read_file', path: 'a.txt' });
    expect(other).toMatchObject({ error: 'read_file failed: boom', fault: false });
  });

  it('adds the restart hint when a web-cache file is missing', () => {
    expect(messages.notFound('web-cache/x.txt').error).toContain('browse_url(url)');
    expect(messages.notFound('notes/x.txt').error).not.toContain('browse_url');
  });

  it('only mentions recursive delete for a directory when deleting', () => {
    expect(messages.isDirectory('d', { forDelete: true }).error).toContain('recursive: true');
    expect(messages.isDirectory('d').error).not.toContain('recursive');
  });

  it('flags a CRLF mismatch in the not-found edit message', () => {
    expect(messages.editTextNotFound('a.txt', { crlfMismatch: true }).error).toContain('\\r\\n');
  });

  it('formats sizes as MiB without trailing zeros', () => {
    expect(messages.formatMiB(10 * MIB)).toBe('10');
    expect(messages.formatMiB(MIB / 2)).toBe('0.5');
  });

  describe('hints', () => {
    it('continues a paged read_file with the next offset', () => {
      expect(messages.readFilePagedHint('a.txt', 50_000)).toContain('read_file(path: "a.txt", offset: 50000)');
    });

    it('continues paged lines with nextLine as startLine', () => {
      expect(messages.readLinesPagedHint('a.txt', 41)).toContain('read_file_lines(path: "a.txt", startLine: 41)');
    });

    it('points a search match at read_file_lines starting five lines earlier, never below line 1', () => {
      expect(messages.searchMatchesHint('a.txt', 115)).toContain('startLine: 110, limit: 20');
      expect(messages.searchMatchesHint('a.txt', 2)).toContain('startLine: 1,');
    });

    it('explains an incomplete search and how to narrow it', () => {
      const hint = messages.searchIncompleteHint('deadline', 200);
      expect(hint).toContain('deadline');
      expect(hint).toContain('max 200');
    });

    it('describes each search stop reason in plain words with the real limits', () => {
      const limits = { maxFiles: 500, maxDepth: 8 };
      expect(messages.searchStopReason('max_files', limits)).toContain('500 files');
      expect(messages.searchStopReason('max_depth', limits)).toContain('8 levels');
      expect(messages.searchStopReason('regex_timeout', limits)).toContain('too long');
      expect(messages.searchStopReason('deadline', limits)).toContain('time limit');
    });
    it('points a limit error on a search to a smaller value or a narrower search', () => {
      const result = messages.limitTooLarge('maxMatches', 500, 200, { forSearch: true });
      expect(result.error).toContain('search_files(path, query)');
      expect(findSignatureProblems(result.error ?? '')).toEqual([]);
    });
    it('tells the agent to rerun a stale search narrower', () => {
      expect(messages.staleSearchHint()).toBe('Run search_files(path, query) again with a narrower query or path.');
    });
    it('continues a capped list with the next offset', () => {
      expect(messages.listCappedHint(500, 1200, 'notes', 500)).toContain('list_files(path: "notes", offset: 500)');
    });

    it('tells the agent how to free space after an unsaved browse_url page', () => {
      const text = messages.browseSaveErrorText();
      expect(text).toContain('delete_file(path)');
      expect(text).toContain('web-cache/');
      expect(findSignatureProblems(text)).toEqual([]);
    });
  });
});

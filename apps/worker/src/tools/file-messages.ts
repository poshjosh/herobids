import type { ToolResult } from '@herobids/domain';
import { getWebCacheConfig } from './file-limits.js';
import { toolCall, toolUse } from './tool-signature.js';
import type { QuotaFailure } from './workspace-quota.js';

/**
 * One function per error code and hint (Design 0a). Every message says what happened
 * (with numbers), and the exact next call written with the tool signature. Tools never
 * build message strings inline.
 */

const MAX_PATH_CHARS = 60;
const BYTES_PER_MIB = 1024 * 1024;

export type FileErrorCode =
  | 'file.path_invalid'
  | 'file.reserved_path'
  | 'file.not_found'
  | 'file.is_directory'
  | 'file.not_a_file'
  | 'file.not_text'
  | 'file.not_a_directory'
  | 'file.too_large'
  | 'file.write_too_large'
  | 'file.content_too_long'
  | 'file.limit_too_large'
  | 'file.quota_exceeded'
  | 'file.permission_denied'
  | 'file.io_error'
  | 'file.delete_too_many'
  | 'edit.text_not_found'
  | 'edit.ambiguous_match'
  | 'edit.no_change'
  | 'search.invalid_pattern';

/** `n` bytes as MiB with up to two decimals, no trailing zeros. */
export function formatMiB(bytes: number): string {
  return String(Math.round((bytes / BYTES_PER_MIB) * 100) / 100);
}

/** Keep long paths from blowing the message size; the tail is the useful part. */
function shown(path: string): string {
  return path.length <= MAX_PATH_CHARS ? path : `…${path.slice(-(MAX_PATH_CHARS - 1))}`;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function agentError(code: FileErrorCode, error: string): ToolResult {
  return { success: false, error, errorCode: code, errorOwner: 'agent', retryable: false, fault: false };
}

// --- errors ---

export function pathInvalid(path: string): ToolResult {
  return agentError(
    'file.path_invalid',
    `Path "${shown(path)}" is not allowed. Use a path relative to the workspace root, for example job-search/jobs.json, with no leading / and no "..". Check folders with ${toolCall('list_files', { path: '' })}.`,
  );
}

export function reservedPath(): ToolResult {
  return agentError(
    'file.reserved_path',
    "'sandbox' is reserved for code execution. Write to another folder, for example notes/<name>.",
  );
}

/** delete_file on the workspace root, `sandbox` or a platform folder. */
export function reservedDeletePath(path: string): ToolResult {
  return agentError('file.reserved_path', `${shown(path)} is managed by the platform and cannot be deleted.`);
}

export function notFound(path: string): ToolResult {
  const parent = parentOf(path);
  let message = `File not found: ${shown(path)}. Check the name with ${toolCall('list_files', { path: parent })} or find it with ${toolUse('search_files', 'path', 'query')}.`;
  if (path.split('/')[0] === getWebCacheConfig().dir) {
    message += ` Cached pages are cleared when the agent restarts; call ${toolUse('browse_url', 'url')} again.`;
  }
  return agentError('file.not_found', message);
}

export function isDirectory(path: string, options: { forDelete?: boolean } = {}): ToolResult {
  let message = `That path is a directory. List it with ${toolCall('list_files', { path })}.`;
  if (options.forDelete) {
    message += ` To delete it and everything inside it call ${toolCall('delete_file', { path, recursive: true })}.`;
  }
  return agentError('file.is_directory', message);
}

export function deleteTooMany(path: string, max: number): ToolResult {
  return agentError(
    'file.delete_too_many',
    `This folder holds more than ${max} files, the limit per call. Delete subfolders one at a time: ${toolCall('list_files', { path })}, then ${toolCall('delete_file', { path: `${path}/<sub>`, recursive: true })}.`,
  );
}

export function notAFile(path: string, action: 'read' | 'written' = 'read'): ToolResult {
  return agentError('file.not_a_file', `${shown(path)} is not a regular file, so it cannot be ${action}.`);
}

/** edit_file on a file that is not valid UTF-8: rewriting it would corrupt the bytes. */
export function notText(path: string): ToolResult {
  return agentError(
    'file.not_text',
    `${shown(path)} is not valid UTF-8 text, so editing it would corrupt it. Replace it whole with ${toolUse('write_file', 'path', 'content')} or use another file.`,
  );
}

export function tooLarge(path: string, sizeBytes: number, maxBytes: number, options: { forEdit?: boolean } = {}): ToolResult {
  const what = options.forEdit ? 'too large to edit' : 'too large to open';
  return agentError(
    'file.too_large',
    `${shown(path)} is ${formatMiB(sizeBytes)} MiB, ${what}; the limit is ${formatMiB(maxBytes)} MiB. Read part of it with ${toolUse('read_file_lines', 'path', 'startLine', 'limit')} or find text with ${toolUse('search_files', 'path', 'query')}.`,
  );
}

export function writeTooLarge(path: string, resultingBytes: number, maxBytes: number): ToolResult {
  return agentError(
    'file.write_too_large',
    `This write would make ${shown(path)} ${formatMiB(resultingBytes)} MiB; the limit is ${formatMiB(maxBytes)} MiB. Continue in a new file with ${toolUse('append_file', 'path', 'content')}.`,
  );
}

export function contentTooLong(
  chars: number,
  maxChars: number,
  tool: 'write_file' | 'append_file' | 'edit_file',
): ToolResult {
  const next = tool === 'write_file'
    ? `Write the first part with ${toolUse('write_file', 'path', 'content')} and the rest with ${toolUse('append_file', 'path', 'content')}.`
    : `Split it and call ${toolUse('append_file', 'path', 'content')} once per part.`;
  return agentError(
    'file.content_too_long',
    `Content is ${chars} characters; the limit per call is ${maxChars}. ${next}`,
  );
}

export function limitTooLarge(name: string, value: number, max: number, options: { forList?: boolean } = {}): ToolResult {
  const next = options.forList
    ? `Page through a long folder with ${toolUse('list_files', 'path', 'offset', 'limit')}.`
    : `For large files use ${toolUse('read_file_lines', 'path', 'startLine', 'limit')} or ${toolUse('search_files', 'path', 'query')}.`;
  return agentError('file.limit_too_large', `${name} ${value} is above the maximum ${max}. ${next}`);
}

export function notADirectory(path: string): ToolResult {
  return agentError(
    'file.not_a_directory',
    `${shown(path)} is a file, not a directory. Read it with ${toolCall('read_file', { path })}.`,
  );
}

export function quotaExceeded(failure: QuotaFailure): ToolResult {
  if (failure.reason === 'walk_capped') {
    return agentError(
      'file.quota_exceeded',
      `The workspace has more than ${failure.walkMaxFiles} files, so its size cannot be measured. Delete a folder you no longer need with ${toolCall('delete_file', { path: failure.topDirs[0]?.name ?? '<dir>', recursive: true })}; list folders with ${toolCall('list_files', { path: '' })}.`,
    );
  }
  const largest = failure.topDirs
    .slice(0, 3)
    .map((dir) => `${shown(dir.name)}/ ${formatMiB(dir.bytes)} MiB`)
    .join(', ');
  const first = failure.topDirs[0]?.name;
  const folderStep = first === undefined
    ? ''
    : `, or ${toolCall('delete_file', { path: first, recursive: true })} for a whole folder; check a file's size with ${toolUse('stat_file', 'path')} and list a folder with ${toolCall('list_files', { path: first })}`;
  return agentError(
    'file.quota_exceeded',
    `The workspace is full (${formatMiB(failure.usedBytes)} of ${formatMiB(failure.quotaBytes)} MiB used${largest ? `; largest: ${largest}` : ''}). Free space with ${toolUse('delete_file', 'path')}${folderStep}. Then repeat this call.`,
  );
}

export function editTextNotFound(path: string, options: { crlfMismatch?: boolean } = {}): ToolResult {
  const crlf = options.crlfMismatch
    ? ' The file uses \\r\\n line endings; include them in oldText.'
    : '';
  return agentError(
    'edit.text_not_found',
    `oldText was not found in ${shown(path)}. Copy it exactly, including spaces and line endings, from ${toolUse('read_file_lines', 'path', 'startLine', 'limit')}, or locate it with ${toolUse('search_files', 'path', 'query')}.${crlf}`,
  );
}

export function editAmbiguousMatch(path: string, matchCount: number): ToolResult {
  return agentError(
    'edit.ambiguous_match',
    `oldText matches ${matchCount} places in ${shown(path)}. Add more surrounding text to oldText, or set replaceAll: true. See where with ${toolUse('search_files', 'path', 'query')}.`,
  );
}

export function editNoChange(): ToolResult {
  return agentError('edit.no_change', 'oldText and newText are the same, so nothing was changed.');
}

export function invalidPattern(engineMessage: string): ToolResult {
  return agentError(
    'search.invalid_pattern',
    `Invalid pattern: ${engineMessage.slice(0, 150)}. Fix it, or set regex: false to search for the text literally.`,
  );
}

/** Real host disk failures only (EIO, ENOSPC). The operator is notified. */
export function ioError(action: string, path: string, errno: string): ToolResult {
  return {
    success: false,
    error: `A platform problem stopped ${action} on ${shown(path)} (${errno}). Do not retry; tell the user.`,
    errorCode: 'file.io_error',
    errorOwner: 'platform',
    retryable: false,
    fault: true,
  };
}

/** EACCES and EPERM are agent-owned: the agent can pick another path. */
export function permissionDenied(path: string): ToolResult {
  return agentError(
    'file.permission_denied',
    `Permission denied for ${shown(path)}. Choose another path, for example under notes/, or check the file with ${toolUse('stat_file', 'path')}.`,
  );
}

/**
 * Map a filesystem error to a ToolResult. Unknown errors keep today's content-level
 * shape (`<action> failed: <message>`, `fault: false`) so they never trip the breaker.
 */
export function fromFsError(error: unknown, context: { action: string; path: string; isDeletePath?: boolean }): ToolResult {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ENOENT':
      return notFound(context.path);
    case 'EISDIR':
      return isDirectory(context.path, { forDelete: context.isDeletePath });
    case 'EACCES':
    case 'EPERM':
      return permissionDenied(context.path);
    case 'EIO':
    case 'ENOSPC':
      return ioError(context.action, context.path, code);
    default: {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `${context.action} failed: ${message}`, retryable: false, fault: false };
    }
  }
}

// --- hints (success results; only on truncation, paging, incomplete or match results) ---

export function readFilePagedHint(path: string, nextOffset: number): string {
  return `More text remains. Continue with ${toolCall('read_file', { path, offset: nextOffset })} or ${toolUse('search_files', 'path', 'query')}.`;
}

export function readLinesPagedHint(path: string, nextLine: number): string {
  return `More lines remain. Continue with ${toolCall('read_file_lines', { path, startLine: nextLine })}.`;
}

/** A single line was longer than maxChars and was cut; continue inside it with read_file. */
export function readLineCutHint(path: string, line: number, continueOffset: number, nextLine: number | null): string {
  const more = nextLine === null ? '' : ` Later lines: ${toolCall('read_file_lines', { path, startLine: nextLine })}.`;
  return `Line ${line} is longer than maxChars and was cut. Read the rest of it with ${toolCall('read_file', { path, offset: continueOffset })}.${more}`;
}

/** Added to the cut marker of an old read_file / read_file_lines result. */
export function staleReadHint(path: string): string {
  return `Read it again with ${toolCall('read_file_lines', { path, startLine: 1, limit: 200 })} or ${toolCall('read_file', { path })}.`;
}

export function searchMatchesHint(file: string, line: number): string {
  return `Read around a match with ${toolCall('read_file_lines', { path: file, startLine: Math.max(line - 5, 1), limit: 20 })}.`;
}

export function searchIncompleteHint(reason: string, maxMatchesLimit: number): string {
  return `Search stopped: ${reason}. Narrow it with path or query, or raise maxMatches (max ${maxMatchesLimit}).`;
}

export function listCappedHint(shownCount: number, total: number, path: string, nextOffset: number): string {
  return `Showing ${shownCount} of ${total}. Continue with ${toolCall('list_files', { path, offset: nextOffset })}.`;
}

export function browseSaveErrorText(): string {
  return `The page is longer than this result and was not saved because the workspace or the web cache is full. Delete files you no longer need, for example old files in web-cache/, with ${toolUse('delete_file', 'path')}, then call ${toolUse('browse_url', 'url')} again with the same URL, or carry on with the first page.`;
}

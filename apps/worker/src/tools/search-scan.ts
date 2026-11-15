import { open, readdir, stat } from 'node:fs/promises';
import type { FileToolsConfig } from '@herobids/domain';
import { createLogger } from '../logger.js';
import { countCodePoints, streamLines, type LineInfo } from './file-text.js';
import type { LineMatcher } from './line-matcher.js';

const logger = createLogger('tools:search-scan');

const BYTES_PER_MIB = 1024 * 1024;
/** A NUL byte in this many leading bytes marks a file as binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** Lines are matched in batches so a regex worker costs one round trip per batch, not per line. */
const BATCH_LINES = 500;
const BATCH_CHARS = 256 * 1024;
const ELLIPSIS = '…';

export type IncompleteReason =
  | 'max_matches'
  | 'result_chars'
  | 'max_files'
  | 'max_bytes'
  | 'deadline'
  | 'max_depth'
  | 'regex_timeout';

export interface SearchMatch {
  file: string;
  line: number;
  /** Character (code point) offset of the match in the file, for read_file. */
  offset: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface SearchOutcome {
  filesScanned: number;
  bytesScanned: number;
  skippedBinary: number;
  skippedLarge: number;
  skippedLongLines: number;
  incomplete: boolean;
  incompleteReason?: IncompleteReason;
  stoppedAt?: { file: string; line?: number };
  matches: SearchMatch[];
}

export interface SearchRunOptions {
  /** Workspace-relative path of the start, `''` for the root, no trailing slash. */
  startRelative: string;
  startAbsolute: string;
  startIsFile: boolean;
  /** Size in bytes of the start path when it is a file. */
  startSizeBytes: number;
  matcher: LineMatcher;
  isRegex: boolean;
  maxMatches: number;
  contextLines: number;
  /** Cap on the JSON size of the returned matches. */
  resultCharsCap: number;
  limits: FileToolsConfig;
  now: () => number;
}

interface PendingContext {
  match: SearchMatch;
  remaining: number;
}

function stripEol(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** First `maxChars` characters of a line, with an ellipsis when cut. */
function clipLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  if (isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return `${text.slice(0, end)}${ELLIPSIS}`;
}

/** At most `maxChars` characters of a line around the match index, with an ellipsis on each cut end. */
function windowAround(text: string, index: number, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let start = Math.max(index - Math.floor(maxChars / 3), 0);
  let end = Math.min(start + maxChars, text.length);
  start = Math.max(end - maxChars, 0);
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start++;
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return `${start > 0 ? ELLIPSIS : ''}${text.slice(start, end)}${end < text.length ? ELLIPSIS : ''}`;
}

async function looksBinary(absolutePath: string): Promise<boolean> {
  const handle = await open(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/**
 * One search over a file or a folder tree. Walks in sorted order, depth first, never
 * follows symlinks, and stops (with `incomplete: true`) when any scan limit is reached.
 */
export class SearchRun {
  private readonly deadlineAt: number;
  private readonly matches: SearchMatch[] = [];
  private resultChars = 0;
  private filesScanned = 0;
  private bytesScanned = 0;
  private skippedBinary = 0;
  private skippedLarge = 0;
  private skippedLongLines = 0;
  private incompleteReason: IncompleteReason | undefined;
  private stoppedAt: { file: string; line?: number } | undefined;
  /** Set when the whole search must end (a limit that makes more scanning pointless). */
  private stopped = false;
  /** Set when no more matches are wanted; the current file is read on only to finish "after" context. */
  private finishing = false;

  constructor(private readonly options: SearchRunOptions) {
    this.deadlineAt = options.now() + options.limits.search.deadlineMs;
  }

  async run(): Promise<SearchOutcome> {
    const { startRelative, startAbsolute, startIsFile, startSizeBytes } = this.options;
    if (startIsFile) await this.scanFile(startAbsolute, startRelative, startSizeBytes);
    else await this.walk(startAbsolute, startRelative, 0);
    return this.outcome();
  }

  private outcome(): SearchOutcome {
    return {
      filesScanned: this.filesScanned,
      bytesScanned: this.bytesScanned,
      skippedBinary: this.skippedBinary,
      skippedLarge: this.skippedLarge,
      skippedLongLines: this.skippedLongLines,
      incomplete: this.incompleteReason !== undefined,
      ...(this.incompleteReason !== undefined ? { incompleteReason: this.incompleteReason } : {}),
      ...(this.stoppedAt !== undefined ? { stoppedAt: this.stoppedAt } : {}),
      matches: this.matches,
    };
  }

  /** Note that results are partial without ending the search (for example a folder past the depth limit). */
  private markIncomplete(reason: IncompleteReason, at?: { file: string; line?: number }): void {
    this.incompleteReason = reason;
    if (at) this.stoppedAt = at;
  }

  /** End the whole search. Always returns false so callers can `return this.stop(...)`. */
  private stop(reason: IncompleteReason, at: { file: string; line?: number }): false {
    this.markIncomplete(reason, at);
    this.stopped = true;
    return false;
  }

  private async walk(absoluteDir: string, relativeDir: string, depth: number): Promise<boolean> {
    const { limits, now } = this.options;
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      // A folder that vanished or cannot be read must not end the search.
      logger.warn({ dir: relativeDir, err: error instanceof Error ? error.message : String(error) }, 'search_files could not read a folder');
      return true;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (now() >= this.deadlineAt) return this.stop('deadline', { file: relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}` });
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      const absolute = `${absoluteDir}/${entry.name}`;

      if (entry.isDirectory()) {
        if (limits.dependencyDirs.includes(entry.name)) continue;
        // Platform folders are only skipped at the top of the workspace.
        if (!relative.includes('/') && limits.platformDirs.includes(entry.name)) continue;
        if (depth + 1 > limits.search.maxDepth) {
          this.markIncomplete('max_depth');
          continue;
        }
        if (!(await this.walk(absolute, relative, depth + 1))) return false;
      } else if (entry.isFile()) {
        let size: number;
        try {
          size = (await stat(absolute)).size;
        } catch (error) {
          logger.warn({ file: relative, err: error instanceof Error ? error.message : String(error) }, 'search_files could not stat a file');
          continue;
        }
        if (!(await this.scanFile(absolute, relative, size))) return false;
      }
    }
    return true;
  }

  /** Returns false when the whole search must end. */
  private async scanFile(absolutePath: string, relativePath: string, sizeBytes: number): Promise<boolean> {
    const { limits, now } = this.options;
    if (now() >= this.deadlineAt) return this.stop('deadline', { file: relativePath });
    if (sizeBytes > limits.maxFileBytes) {
      this.skippedLarge++;
      return true;
    }
    if (this.filesScanned >= limits.search.maxFiles) return this.stop('max_files', { file: relativePath });
    if (this.bytesScanned + sizeBytes > limits.search.maxScanMb * BYTES_PER_MIB) {
      return this.stop('max_bytes', { file: relativePath });
    }

    try {
      if (await looksBinary(absolutePath)) {
        this.skippedBinary++;
        return true;
      }
      this.filesScanned++;
      this.bytesScanned += sizeBytes;
      return await this.scanLines(absolutePath, relativePath);
    } catch (error) {
      // A file that vanished or cannot be read must not end the search.
      logger.warn({ file: relativePath, err: error instanceof Error ? error.message : String(error) }, 'search_files could not read a file');
      return true;
    }
  }

  private async scanLines(absolutePath: string, file: string): Promise<boolean> {
    const { matcher, isRegex, maxMatches, contextLines, limits } = this.options;
    const lineMaxChars = limits.search.lineMaxChars;
    const before: string[] = [];
    let pending: PendingContext[] = [];
    let batch: LineInfo[] = [];
    let batchChars = 0;
    const mustEnd = (): boolean => this.stopped || (this.finishing && pending.length === 0);

    const flush = async (): Promise<boolean> => {
      const lines = batch;
      batch = [];
      batchChars = 0;
      const firstLine = lines[0]?.number;
      const at = firstLine === undefined ? { file } : { file, line: firstLine };

      let hits: number[] | undefined;
      if (!this.finishing) {
        if (this.options.now() >= this.deadlineAt) return this.stop('deadline', at);
        const bodies: string[] = [];
        const bodyLineIndex: number[] = [];
        lines.forEach((line, index) => {
          const body = stripEol(line.text);
          // Regex lines over the cap are skipped: a long line is where a slow pattern hurts most.
          if (isRegex && body.length > limits.search.regexLineMaxChars) {
            this.skippedLongLines++;
            return;
          }
          bodies.push(body);
          bodyLineIndex.push(index);
        });
        const outcome = await matcher.matchLines(bodies, this.deadlineAt - this.options.now());
        if ('stopped' in outcome) return this.stop(outcome.stopped, at);
        const byLine = new Array<number>(lines.length).fill(-1);
        outcome.hits.forEach((hit, position) => {
          const index = bodyLineIndex[position];
          if (index !== undefined) byLine[index] = hit;
        });
        hits = byLine;
      }

      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        const body = stripEol(line.text);

        for (const entry of pending) {
          (entry.match.after ??= []).push(clipLine(body, lineMaxChars));
          entry.remaining--;
        }
        pending = pending.filter((entry) => entry.remaining > 0);

        const hit = hits?.[index] ?? -1;
        if (!this.finishing && hit >= 0) {
          if (this.matches.length >= maxMatches) {
            // One match more than wanted exists, so the result really is partial.
            this.markIncomplete('max_matches', { file, line: line.number });
            this.finishing = true;
          } else {
            const match: SearchMatch = {
              file,
              line: line.number,
              offset: line.startOffset + countCodePoints(body.slice(0, hit)),
              text: windowAround(body, hit, lineMaxChars),
              ...(before.length > 0 ? { before: [...before] } : {}),
            };
            const cost = JSON.stringify(match).length;
            if (this.matches.length > 0 && this.resultChars + cost > this.options.resultCharsCap) {
              this.markIncomplete('result_chars', { file, line: line.number });
              this.finishing = true;
            } else {
              this.matches.push(match);
              this.resultChars += cost;
              if (contextLines > 0) pending.push({ match, remaining: contextLines });
            }
          }
        }

        if (contextLines > 0) {
          before.push(clipLine(body, lineMaxChars));
          if (before.length > contextLines) before.shift();
        }
      }
      return !mustEnd();
    };

    for await (const line of streamLines(absolutePath)) {
      batch.push(line);
      batchChars += line.text.length;
      if (batch.length >= BATCH_LINES || batchChars >= BATCH_CHARS) {
        if (!(await flush())) return false;
      }
    }
    if (batch.length > 0 && !(await flush())) return false;
    // Hitting a match or result limit ends the search even if "after" context was cut short by the file end.
    return !(this.stopped || this.finishing);
  }
}

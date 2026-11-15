import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/**
 * Text helpers for the file tools. All counts, offsets and limits are Unicode code
 * points, so a page never splits a surrogate pair. Files are streamed in 64 KiB chunks
 * and decoded with `StringDecoder('utf8')`, which keeps multi-byte sequences whole and
 * turns invalid bytes into U+FFFD (as `fs.readFile(..., 'utf8')` does).
 */

const CHUNK_BYTES = 64 * 1024;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Number of code points in a string. */
export function countCodePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isHighSurrogate(code) && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

/** UTF-16 index where code point number `codePoints` starts (clamped to the string end). */
export function utf16IndexOfCodePoint(text: string, codePoints: number): number {
  let index = 0;
  let seen = 0;
  while (seen < codePoints && index < text.length) {
    const code = text.charCodeAt(index);
    index += isHighSurrogate(code) && index + 1 < text.length ? 2 : 1;
    seen++;
  }
  return index;
}

/** Substring by code point positions [start, end). */
export function sliceCodePoints(text: string, start: number, end: number): string {
  const from = utf16IndexOfCodePoint(text, start);
  const to = from + utf16IndexOfCodePoint(text.slice(from), Math.max(end - start, 0));
  return text.slice(from, to);
}

/** Stream a file as decoded text chunks. A chunk never ends inside a character. */
export async function* streamTextChunks(absolutePath: string): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  const stream = createReadStream(absolutePath, { highWaterMark: CHUNK_BYTES });
  try {
    for await (const chunk of stream) {
      const text = decoder.write(chunk as Buffer);
      if (text.length > 0) yield text;
    }
    const rest = decoder.end();
    if (rest.length > 0) yield rest;
  } finally {
    stream.destroy();
  }
}

export interface LineInfo {
  /** 1-based line number. */
  number: number;
  /** Line text including its terminator (`\n` or `\r\n`) when it has one. */
  text: string;
  /** Code point offset of the line start in the file. */
  startOffset: number;
  /** Length of `text` in code points. */
  length: number;
}

/**
 * Stream a file line by line. Lines split on `\n` only; a trailing `\r` stays with its
 * line. An empty final segment (file ends with a newline) is not a line.
 */
export async function* streamLines(absolutePath: string): AsyncGenerator<LineInfo> {
  let carry = '';
  let number = 0;
  let offset = 0;
  const emit = (text: string): LineInfo => {
    const length = countCodePoints(text);
    const info: LineInfo = { number: ++number, text, startOffset: offset, length };
    offset += length;
    return info;
  };

  for await (const chunk of streamTextChunks(absolutePath)) {
    let start = 0;
    let newline = chunk.indexOf('\n', start);
    while (newline !== -1) {
      yield emit(carry + chunk.slice(start, newline + 1));
      carry = '';
      start = newline + 1;
      newline = chunk.indexOf('\n', start);
    }
    carry += chunk.slice(start);
  }
  if (carry.length > 0) yield emit(carry);
}

// --- character pages (read_file) ---

export interface CharPage {
  content: string;
  returnedChars: number;
  totalChars: number;
  totalLines: number;
  /** Offset to pass back as `offset`; null when the page reaches the end. */
  nextOffset: number | null;
}

/**
 * Read `limit` code points starting at code point `offset`. The whole file is scanned
 * (streamed, never held) because the totals are part of the result.
 */
export async function readCharPage(absolutePath: string, offset: number, limit: number): Promise<CharPage> {
  const end = offset + limit;
  const parts: string[] = [];
  let position = 0;
  let newlines = 0;
  let lastChar = '';

  for await (const chunk of streamTextChunks(absolutePath)) {
    const chunkChars = countCodePoints(chunk);
    for (let at = chunk.indexOf('\n'); at !== -1; at = chunk.indexOf('\n', at + 1)) newlines++;
    lastChar = chunk[chunk.length - 1] ?? lastChar;

    const chunkEnd = position + chunkChars;
    if (chunkEnd > offset && position < end) {
      parts.push(sliceCodePoints(chunk, Math.max(offset - position, 0), Math.min(end - position, chunkChars)));
    }
    position = chunkEnd;
  }

  const content = parts.join('');
  const returnedChars = countCodePoints(content);
  const reached = offset + returnedChars;
  const totalLines = position === 0 ? 0 : newlines + (lastChar === '\n' ? 0 : 1);
  return {
    content,
    returnedChars,
    totalChars: position,
    totalLines,
    nextOffset: reached < position ? reached : null,
  };
}

// --- line pages (read_file_lines) ---

export interface LinePage {
  content: string;
  startLine: number;
  /** Last line included; null when no line was returned. */
  endLine: number | null;
  totalLines: number;
  /** Line to pass back as `startLine`; null when done. */
  nextLine: number | null;
  /** One line was longer than the cap and was cut. */
  lineCut: boolean;
  /** Code point offset of the cut line, for `read_file`. Only with `lineCut`. */
  lineStartOffset?: number;
}

export interface LinePageOptions {
  startLine: number;
  /** Maximum number of lines; unlimited when absent (the character cap still applies). */
  limit?: number;
  /** Character cap in code points. */
  maxChars: number;
}

/**
 * Read whole lines from `startLine`, stopping before the line that would pass `maxChars`
 * or after `limit` lines. A first line longer than `maxChars` is cut instead. The file is
 * scanned to the end so `totalLines` is exact.
 */
export async function readLinePage(absolutePath: string, options: LinePageOptions): Promise<LinePage> {
  const { startLine, limit, maxChars } = options;
  const parts: string[] = [];
  let usedChars = 0;
  let included = 0;
  let endLine: number | null = null;
  let nextLine: number | null = null;
  let totalLines = 0;
  let stopped = false;
  let lineCut = false;
  let lineStartOffset: number | undefined;

  for await (const line of streamLines(absolutePath)) {
    totalLines = line.number;
    if (line.number < startLine) continue;
    if (stopped) continue;

    if (limit !== undefined && included >= limit) {
      stopped = true;
      nextLine = line.number;
    } else if (usedChars + line.length > maxChars) {
      stopped = true;
      if (included === 0) {
        parts.push(sliceCodePoints(line.text, 0, maxChars));
        usedChars = maxChars;
        included = 1;
        endLine = line.number;
        lineCut = true;
        lineStartOffset = line.startOffset;
        nextLine = line.number + 1;
      } else {
        nextLine = line.number;
      }
    } else {
      parts.push(line.text);
      usedChars += line.length;
      included++;
      endLine = line.number;
    }
  }

  // After a cut line the next line may not exist.
  if (nextLine !== null && nextLine > totalLines) nextLine = null;

  return {
    content: parts.join(''),
    startLine,
    endLine,
    totalLines,
    nextLine,
    lineCut,
    ...(lineCut && lineStartOffset !== undefined ? { lineStartOffset } : {}),
  };
}

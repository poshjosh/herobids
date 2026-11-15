import { Worker } from 'node:worker_threads';
import { createLogger } from '../logger.js';

const logger = createLogger('tools:line-matcher');

/** Memory ceiling for the regex worker, so a runaway pattern cannot take the container down. */
const WORKER_MAX_OLD_GENERATION_MB = 64;

export type BatchOutcome =
  | { hits: number[] }
  | { stopped: 'regex_timeout' };

/** Finds the first match in each line. `hits[i]` is a UTF-16 index, or -1 for no match. */
export interface LineMatcher {
  matchLines(lines: string[], timeLeftMs: number): Promise<BatchOutcome>;
  /** Release resources (terminates the worker). Safe to call more than once. */
  close(): Promise<void>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Literal search on the calling thread. Case-sensitive search uses `indexOf`; the
 * case-insensitive form uses an escaped pattern with the `i` flag, which keeps the
 * match index valid even for characters whose lower-case form has a different length.
 * An escaped literal cannot backtrack catastrophically, so it needs no worker.
 */
export function createLiteralMatcher(query: string, caseInsensitive: boolean): LineMatcher {
  const pattern = caseInsensitive ? new RegExp(escapeRegExp(query), 'i') : undefined;
  return {
    async matchLines(lines) {
      const hits = lines.map((line) => (pattern ? (pattern.exec(line)?.index ?? -1) : line.indexOf(query)));
      return { hits };
    },
    async close() {},
  };
}

// Self-contained CommonJS source run with `eval: true`: no extra file to compile or
// resolve under tsc, tsx or vitest. The pattern is compiled once; each message is a
// batch of lines and the reply is one hit index per line.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const re = new RegExp(workerData.source, workerData.flags);
parentPort.on('message', (msg) => {
  const hits = new Array(msg.lines.length);
  for (let i = 0; i < msg.lines.length; i++) {
    const m = re.exec(msg.lines[i]);
    hits[i] = m ? m.index : -1;
  }
  parentPort.postMessage({ id: msg.id, hits });
});
`;

let activeWorkers = 0;

/** Number of regex workers currently alive (for tests that check nothing is left running). */
export function getActiveRegexWorkerCount(): number {
  return activeWorkers;
}

function isReply(value: unknown): value is { id: number; hits: number[] } {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as { id?: unknown; hits?: unknown };
  return typeof reply.id === 'number' && Array.isArray(reply.hits);
}

/**
 * Regex search in one worker thread per search. The caller compiles the pattern first
 * (to report `search.invalid_pattern`); the worker compiles it again. If a batch does not
 * come back within the time left, the worker is terminated and the search ends with
 * `regex_timeout`: `RegExp.exec` cannot be interrupted any other way.
 */
export function createRegexMatcher(source: string, flags: string): LineMatcher {
  let worker: Worker | undefined;
  let terminating: Promise<number> | undefined;
  let nextId = 0;

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const created = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source, flags },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB },
    });
    activeWorkers++;
    created.once('exit', () => { activeWorkers--; });
    worker = created;
    return created;
  };

  const terminate = (): Promise<number> => {
    if (!worker) return Promise.resolve(0);
    terminating ??= worker.terminate();
    return terminating;
  };

  return {
    matchLines(lines, timeLeftMs) {
      const active = ensureWorker();
      const id = nextId++;
      return new Promise<BatchOutcome>((resolve) => {
        const finish = (outcome: BatchOutcome): void => {
          clearTimeout(timer);
          active.off('message', onMessage);
          active.off('error', onError);
          active.off('exit', onExit);
          resolve(outcome);
        };
        const onMessage = (value: unknown): void => {
          if (isReply(value) && value.id === id) finish({ hits: value.hits });
        };
        const onError = (error: Error): void => {
          // Includes the worker running out of memory. The search cannot go on without it.
          logger.warn({ err: error.message }, 'regex worker failed');
          void terminate();
          finish({ stopped: 'regex_timeout' });
        };
        const onExit = (): void => finish({ stopped: 'regex_timeout' });
        const timer = setTimeout(() => {
          void terminate();
          finish({ stopped: 'regex_timeout' });
        }, Math.max(timeLeftMs, 0));

        active.on('message', onMessage);
        active.on('error', onError);
        active.on('exit', onExit);
        active.postMessage({ id, lines });
      });
    },
    async close() {
      await terminate();
    },
  };
}

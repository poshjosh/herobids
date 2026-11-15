import { z } from 'zod';
import { stat } from 'node:fs/promises';
import { normalize } from 'node:path';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolContext, ToolResult } from '@herobids/domain';
import { getFileToolLimits } from './file-limits.js';
import * as messages from './file-messages.js';
import { createLiteralMatcher, createRegexMatcher, type LineMatcher } from './line-matcher.js';
import { convertZodToJsonSchema } from './registry.js';
import { SearchRun, type SearchOutcome } from './search-scan.js';
import { toolUse } from './tool-signature.js';
import { ensureWorkspaceDirs, getWorkspacePaths, resolveWorkspacePath } from './workspace.js';

const logger = createLogger('tools:search-files');

const limits = getFileToolLimits();

const SearchFilesParamsSchema = z.object({
  path: z.string().optional()
    .describe('File or folder to search, relative to the workspace root. Default: the whole workspace.'),
  query: z.string().min(1).regex(/^[^\r\n]+$/, 'query must be a single line')
    .describe(`Text to find, one line, at most ${limits.search.maxQueryChars} characters. Matched literally unless regex is true.`),
  regex: z.boolean().optional()
    .describe(`Treat query as a regular expression (JavaScript syntax, at most ${limits.search.maxRegexChars} characters). Default false (literal text).`),
  caseInsensitive: z.boolean().optional()
    .describe('Ignore letter case. Default false.'),
  maxMatches: z.coerce.number().int().min(1).optional()
    .describe(`Most matches to return. Default ${limits.search.defaultMatches}, maximum ${limits.search.maxMatches}.`),
  contextLines: z.coerce.number().int().min(0).optional()
    .describe(`Lines of context to return before and after each match. Default 0, maximum ${limits.search.contextMaxLines}.`),
});

export const searchFilesTool: AgentTool = {
  name: 'search_files',
  description: `Search for text in one file or a whole folder of the agent workspace. Returns pointers, not whole files: for each match the file, 1-based line, character offset and the matching line (cut to ${limits.search.lineMaxChars} characters). One match is reported per line. Literal by default; set regex: true for a pattern. Skips binary files and dependency folders, and does not follow symlinks. If a scan limit is reached it returns the matches found so far with incomplete: true. Then read around a match with ${toolUse('read_file_lines', 'path', 'startLine', 'limit')} or ${toolUse('read_file', 'path', 'offset')}.`,
  parametersSchema: SearchFilesParamsSchema,
  parameters: convertZodToJsonSchema(SearchFilesParamsSchema),
  category: 'read-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const {
      path: relativePath = '',
      query,
      regex = false,
      caseInsensitive = false,
      maxMatches,
      contextLines = 0,
    } = params as z.infer<typeof SearchFilesParamsSchema>;

    const current = getFileToolLimits();
    const search = current.search;
    const wantedMatches = maxMatches ?? search.defaultMatches;

    if (query.length > search.maxQueryChars) {
      return messages.limitTooLarge('query', query.length, search.maxQueryChars, { forSearch: true });
    }
    if (wantedMatches > search.maxMatches) {
      return messages.limitTooLarge('maxMatches', wantedMatches, search.maxMatches, { forSearch: true });
    }
    if (contextLines > search.contextMaxLines) {
      return messages.limitTooLarge('contextLines', contextLines, search.contextMaxLines, { forSearch: true });
    }

    const flags = caseInsensitive ? 'i' : '';
    if (regex) {
      if (query.length > search.maxRegexChars) {
        return messages.invalidPattern(`the pattern is ${query.length} characters; the maximum is ${search.maxRegexChars}`);
      }
      try {
        new RegExp(query, flags);
      } catch (error) {
        return messages.invalidPattern(error instanceof Error ? error.message : String(error));
      }
    }

    const paths = getWorkspacePaths(ctx.agentId);
    await ensureWorkspaceDirs(paths);
    const resolved = await resolveWorkspacePath(paths.root, relativePath);
    if (!resolved.ok) return messages.pathInvalid(relativePath);

    let startIsFile: boolean;
    let startSizeBytes = 0;
    try {
      const startStat = await stat(resolved.absolutePath);
      if (startStat.isFile()) {
        if (startStat.size > current.maxFileBytes) {
          return messages.tooLarge(relativePath, startStat.size, current.maxFileBytes);
        }
        startIsFile = true;
        startSizeBytes = startStat.size;
      } else if (startStat.isDirectory()) {
        startIsFile = false;
      } else {
        return messages.notAFile(relativePath);
      }
    } catch (error) {
      return messages.fromFsError(error, { action: 'searching', path: relativePath });
    }

    // With the default match count the result text stays small; raising maxMatches also raises the text cap.
    const resultCharsCap = wantedMatches > search.defaultMatches ? current.readDefaultChars : search.defaultResultChars;

    const matcher: LineMatcher = regex ? createRegexMatcher(query, flags) : createLiteralMatcher(query, caseInsensitive);
    try {
      const outcome = await new SearchRun({
        startRelative: toRelative(relativePath),
        startAbsolute: resolved.absolutePath,
        startIsFile,
        startSizeBytes,
        matcher,
        isRegex: regex,
        maxMatches: wantedMatches,
        contextLines,
        resultCharsCap,
        limits: current,
        now: Date.now,
      }).run();
      logger.debug({ agentId: ctx.agentId, path: relativePath, regex, matches: outcome.matches.length, incomplete: outcome.incomplete }, 'search_files success');
      return { success: true, data: buildData(relativePath, query, regex, outcome) };
    } catch (error) {
      logger.warn({ agentId: ctx.agentId, path: relativePath, err: error instanceof Error ? error.message : String(error) }, 'search_files error');
      return messages.fromFsError(error, { action: 'searching', path: relativePath });
    } finally {
      await matcher.close();
    }
  },
};

/** Workspace-relative path with no `./` prefix and no trailing slash; `''` for the root. */
function toRelative(relativePath: string): string {
  const normalized = normalize(relativePath);
  if (normalized === '.' || normalized === './') return '';
  return normalized.replace(/\/+$/, '');
}

function buildData(path: string, query: string, regex: boolean, outcome: SearchOutcome): Record<string, unknown> {
  const hint = buildHint(outcome);
  return {
    path,
    query,
    regex,
    returnedMatches: outcome.matches.length,
    filesScanned: outcome.filesScanned,
    bytesScanned: outcome.bytesScanned,
    skippedBinary: outcome.skippedBinary,
    skippedLarge: outcome.skippedLarge,
    skippedLongLines: outcome.skippedLongLines,
    incomplete: outcome.incomplete,
    ...(outcome.incompleteReason !== undefined ? { incompleteReason: outcome.incompleteReason } : {}),
    ...(outcome.stoppedAt !== undefined ? { stoppedAt: outcome.stoppedAt } : {}),
    ...(hint !== undefined ? { hint } : {}),
    matches: outcome.matches,
  };
}

/** Only results that need a next step carry a hint: matches to read around, or a partial search. */
function buildHint(outcome: SearchOutcome): string | undefined {
  const parts: string[] = [];
  if (outcome.incompleteReason !== undefined) {
    const search = getFileToolLimits().search;
    parts.push(messages.searchIncompleteHint(messages.searchStopReason(outcome.incompleteReason, search), search.maxMatches));
  }
  const first = outcome.matches[0];
  if (first !== undefined) parts.push(messages.searchMatchesHint(first.file, first.line));
  return parts.length > 0 ? parts.join(' ') : undefined;
}

import { z } from 'zod';
import { writeFile as fsWriteFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { appendFileTool } from './append-file.js';
import { deleteFileTool } from './delete-file.js';
import { editFileTool } from './edit-file.js';
import { resolveReadableFile } from './file-access.js';
import { getFileToolLimits } from './file-limits.js';
import * as messages from './file-messages.js';
import { readCharPage } from './file-text.js';
import { checkWriteBudget, checkWriteChars, resolveWritableTarget } from './file-write.js';
import { readFileLinesTool } from './read-file-lines.js';
import { toolUse } from './tool-signature.js';
import { getWorkspacePaths, ensureWorkspaceDirs, resolveWorkspacePath } from './workspace.js';

const logger = createLogger('tools:filesystem');

// --- write_file ---

const fileLimits = getFileToolLimits();

const WriteFileParamsSchema = z.object({
  path: z.string().min(1).describe('Relative path within the workspace (e.g. "notes/log.txt")'),
  content: z.string().describe(`File content to write. At most ${fileLimits.writeMaxChars} characters per call.`),
});

const writeFileTool: AgentTool = {
  name: 'write_file',
  description: `Create or overwrite a file in the agent workspace. Path is relative to the workspace root. At most ${fileLimits.writeMaxChars} characters per call (keep each write under about 12000); for more, write the first part here and add the rest with ${toolUse('append_file', 'path', 'content')}. Change part of a file with ${toolUse('edit_file', 'path', 'oldText', 'newText')} instead of rewriting it. The sandbox directory is reserved for code execution and cannot be written here.`,
  parametersSchema: WriteFileParamsSchema,
  parameters: convertZodToJsonSchema(WriteFileParamsSchema),
  category: 'write-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: relativePath, content } = params as z.infer<typeof WriteFileParamsSchema>;

    const tooLong = checkWriteChars(content, 'write_file');
    if (tooLong) return tooLong;

    const target = await resolveWritableTarget(ctx.agentId, relativePath);
    if (!target.ok) return target.result;

    try {
      const bytesWritten = Buffer.byteLength(content, 'utf8');
      // Overwriting counts only the net growth against the quota.
      const rejected = await checkWriteBudget(
        target.root,
        relativePath,
        bytesWritten,
        bytesWritten - (target.existing?.sizeBytes ?? 0),
      );
      if (rejected) return rejected;

      await mkdir(dirname(target.absolutePath), { recursive: true });
      await fsWriteFile(target.absolutePath, content, 'utf8');
      logger.debug({ agentId: ctx.agentId, path: relativePath, bytes: bytesWritten }, 'write_file success');
      return { success: true, data: { path: relativePath, bytesWritten } };
    } catch (err) {
      logger.warn({ agentId: ctx.agentId, path: relativePath, err: err instanceof Error ? err.message : String(err) }, 'write_file error');
      return messages.fromFsError(err, { action: 'writing', path: relativePath });
    }
  },
};

// --- read_file ---

const ReadFileParamsSchema = z.object({
  path: z.string().min(1).describe('Relative path within the workspace to read'),
  offset: z.coerce.number().int().min(0).optional()
    .describe('Character (not byte) position to start from. Default 0. Pass back nextOffset from the previous result to continue.'),
  limit: z.coerce.number().int().min(1).optional()
    .describe(`Number of characters to return. Default ${fileLimits.readDefaultChars}, maximum ${fileLimits.readMaxChars}. About 4 characters cost one token, so large values use a lot of context.`),
});

const readFileTool: AgentTool = {
  name: 'read_file',
  description: `Read a page of text from a file in the agent workspace, up to ${fileLimits.maxFileBytes} bytes. Path is relative to the workspace root. Returns at most limit characters (default ${fileLimits.readDefaultChars}, max ${fileLimits.readMaxChars}) plus totalChars, totalLines and nextOffset for the next page. A large page can fill your context window: for big files prefer ${toolUse('read_file_lines', 'path', 'startLine', 'limit')} or ${toolUse('search_files', 'path', 'query')}. Files in the sandbox directory can be read to inspect code execution outputs.`,
  parametersSchema: ReadFileParamsSchema,
  parameters: convertZodToJsonSchema(ReadFileParamsSchema),
  category: 'read-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: relativePath, offset = 0, limit = fileLimits.readDefaultChars } =
      params as z.infer<typeof ReadFileParamsSchema>;

    if (limit > fileLimits.readMaxChars) {
      return messages.limitTooLarge('limit', limit, fileLimits.readMaxChars);
    }

    const file = await resolveReadableFile(ctx.agentId, relativePath, 'reading');
    if (!file.ok) return file.result;

    try {
      const page = await readCharPage(file.absolutePath, offset, limit);
      logger.debug({ agentId: ctx.agentId, path: relativePath, chars: page.returnedChars }, 'read_file success');
      return {
        success: true,
        data: {
          path: relativePath,
          offset,
          returnedChars: page.returnedChars,
          totalChars: page.totalChars,
          totalLines: page.totalLines,
          nextOffset: page.nextOffset,
          truncated: page.nextOffset !== null,
          ...(page.nextOffset !== null ? { hint: messages.readFilePagedHint(relativePath, page.nextOffset) } : {}),
          content: page.content,
        },
      };
    } catch (error) {
      logger.warn({ agentId: ctx.agentId, path: relativePath, err: error instanceof Error ? error.message : String(error) }, 'read_file error');
      return messages.fromFsError(error, { action: 'reading', path: relativePath });
    }
  },
};

// --- list_files ---

const ListFilesParamsSchema = z.object({
  path: z.string().optional().default('').describe('Relative directory path to list. Defaults to workspace root.'),
  offset: z.coerce.number().int().min(0).optional().describe('Number of entries to skip. Default 0. Pass back nextOffset to continue.'),
  limit: z.coerce.number().int().min(1).optional()
    .describe(`Number of entries to return. Default ${fileLimits.list.defaultEntries}, maximum ${fileLimits.list.maxEntries}.`),
});

const listFilesTool: AgentTool = {
  name: 'list_files',
  description: `List files and directories in the agent workspace. Path is relative to the workspace root (default: root). Directories are returned with a trailing slash. Returns at most limit entries (default ${fileLimits.list.defaultEntries}, max ${fileLimits.list.maxEntries}) with totalEntries and nextOffset for the next page.`,
  parametersSchema: ListFilesParamsSchema,
  parameters: convertZodToJsonSchema(ListFilesParamsSchema),
  category: 'read-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: relativePath, offset = 0, limit = fileLimits.list.defaultEntries } =
      params as z.infer<typeof ListFilesParamsSchema>;

    if (limit > fileLimits.list.maxEntries) {
      return messages.limitTooLarge('limit', limit, fileLimits.list.maxEntries, { forList: true });
    }

    const paths = getWorkspacePaths(ctx.agentId);
    await ensureWorkspaceDirs(paths);

    // Empty path means root
    const targetRelative = relativePath || '.';

    let absolutePath: string;
    if (targetRelative === '.') {
      absolutePath = paths.root;
    } else {
      const resolved = await resolveWorkspacePath(paths.root, targetRelative);
      if (!resolved.ok) return messages.pathInvalid(relativePath);
      absolutePath = resolved.absolutePath;
    }

    try {
      const entries = await readdir(absolutePath, { withFileTypes: true });
      const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      const page = names.slice(offset, offset + limit);
      const reached = offset + page.length;
      const nextOffset = reached < names.length ? reached : null;
      logger.debug({ agentId: ctx.agentId, path: relativePath, count: page.length }, 'list_files success');
      return {
        success: true,
        data: {
          path: relativePath || '/',
          totalEntries: names.length,
          offset,
          nextOffset,
          truncated: nextOffset !== null,
          ...(nextOffset !== null
            ? { hint: messages.listCappedHint(page.length, names.length, relativePath, nextOffset) }
            : {}),
          entries: page,
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') return messages.notADirectory(relativePath);
      logger.warn({ agentId: ctx.agentId, path: relativePath, err: err instanceof Error ? err.message : String(err) }, 'list_files error');
      return messages.fromFsError(err, { action: 'listing', path: relativePath });
    }
  },
};

// --- stat_file ---

const StatFileParamsSchema = z.object({
  path: z.string().min(1).describe('Relative path within the workspace to inspect'),
});

const statFileTool: AgentTool = {
  name: 'stat_file',
  description: 'Get metadata about a file or directory in the agent workspace. Returns exists, isDir, size (bytes), and modification time. Use this before read_file or delete_file to avoid errors on missing files, or to check if a path is a directory before calling list_files.',
  parametersSchema: StatFileParamsSchema,
  parameters: convertZodToJsonSchema(StatFileParamsSchema),
  category: 'read-filesystem',
  promptGuidance: 'stat_file checks whether a path exists, its type (file or directory), and size — useful before read_file or delete_file to avoid errors on missing or unexpected paths.',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: relativePath } = params as z.infer<typeof StatFileParamsSchema>;

    const paths = getWorkspacePaths(ctx.agentId);
    await ensureWorkspaceDirs(paths);

    const resolved = await resolveWorkspacePath(paths.root, relativePath);
    if (!resolved.ok) {
      return { success: false, error: resolved.error, retryable: false, fault: false };
    }

    try {
      const fileStat = await stat(resolved.absolutePath);
      return {
        success: true,
        data: {
          path: relativePath,
          exists: true,
          isDir: fileStat.isDirectory(),
          isFile: fileStat.isFile(),
          size: Number(fileStat.size),
          modifiedAt: fileStat.mtime.toISOString(),
          createdAt: fileStat.birthtime.toISOString(),
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          success: true,
          data: {
            path: relativePath,
            exists: false,
            isDir: null,
            isFile: null,
            size: null,
            modifiedAt: null,
            createdAt: null,
          },
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ agentId: ctx.agentId, path: relativePath, err: msg }, 'stat_file error');
      return { success: false, error: `stat_file failed: ${msg}`, retryable: false, fault: false };
    }
  },
};

export const filesystemTools: AgentTool[] = [
  writeFileTool,
  appendFileTool,
  editFileTool,
  readFileTool,
  readFileLinesTool,
  listFilesTool,
  deleteFileTool,
  statFileTool,
];

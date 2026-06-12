import { z } from 'zod';
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import pino from 'pino';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { getWorkspacePaths, ensureWorkspaceDirs, resolveWorkspacePath, checkReservedDir } from './workspace.js';

const logger = pino({ name: 'tools:filesystem' });

// Maximum file size for read_file (1 MiB)
const MAX_READ_BYTES = 1_048_576;

// --- write_file ---

const WriteFileParamsSchema = z.object({
  path: z.string().min(1).describe('Relative path within the workspace (e.g. "notes/log.txt")'),
  content: z.string().describe('File content to write'),
});

const writeFileTool: AgentTool = {
  name: 'write_file',
  description: 'Create or overwrite a file in the agent workspace. Path is relative to the workspace root. The sandbox directory is reserved for code execution and cannot be written here.',
  parametersSchema: WriteFileParamsSchema,
  parameters: convertZodToJsonSchema(WriteFileParamsSchema),
  category: 'write-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: relativePath, content } = params as z.infer<typeof WriteFileParamsSchema>;

    const reservedErr = checkReservedDir(relativePath);
    if (reservedErr) {
      return { success: false, error: reservedErr, retryable: false };
    }

    const paths = getWorkspacePaths(ctx.agentId);
    await ensureWorkspaceDirs(paths);

    const resolved = await resolveWorkspacePath(paths.root, relativePath);
    if (!resolved.ok) {
      return { success: false, error: resolved.error, retryable: false };
    }

    try {
      const parentDir = join(resolved.absolutePath, '..');
      await mkdir(parentDir, { recursive: true });
      await fsWriteFile(resolved.absolutePath, content, 'utf8');
      const bytesWritten = Buffer.byteLength(content, 'utf8');
      logger.debug({ agentId: ctx.agentId, path: relativePath, bytes: bytesWritten }, 'write_file success');
      return { success: true, data: { path: relativePath, bytesWritten } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ agentId: ctx.agentId, path: relativePath, err: msg }, 'write_file error');
      return { success: false, error: `write_file failed: ${msg}`, retryable: false };
    }
  },
};

// --- read_file ---

const ReadFileParamsSchema = z.object({
  path: z.string().min(1).describe('Relative path within the workspace to read'),
});

const readFileTool: AgentTool = {
  name: 'read_file',
  description: 'Read the contents of a file in the agent workspace. Path is relative to the workspace root. Files in the sandbox directory can be read to inspect code execution outputs.',
  parametersSchema: ReadFileParamsSchema,
  parameters: convertZodToJsonSchema(ReadFileParamsSchema),
  category: 'read-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: relativePath } = params as z.infer<typeof ReadFileParamsSchema>;

    const paths = getWorkspacePaths(ctx.agentId);
    await ensureWorkspaceDirs(paths);

    const resolved = await resolveWorkspacePath(paths.root, relativePath);
    if (!resolved.ok) {
      return { success: false, error: resolved.error, retryable: false };
    }

    try {
      const fileStat = await stat(resolved.absolutePath);
      if (fileStat.isDirectory()) {
        return { success: false, error: 'path is a directory; use list_files to inspect directories', retryable: false };
      }
      if (fileStat.size > MAX_READ_BYTES) {
        return { success: false, error: `file too large (${fileStat.size} bytes); max is ${MAX_READ_BYTES} bytes`, retryable: false };
      }

      const content = await fsReadFile(resolved.absolutePath, 'utf8');
      logger.debug({ agentId: ctx.agentId, path: relativePath, bytes: content.length }, 'read_file success');
      return { success: true, data: { path: relativePath, content } };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { success: false, error: `file not found: ${relativePath}`, retryable: false };
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ agentId: ctx.agentId, path: relativePath, err: msg }, 'read_file error');
      return { success: false, error: `read_file failed: ${msg}`, retryable: false };
    }
  },
};

// --- list_files ---

const ListFilesParamsSchema = z.object({
  path: z.string().optional().default('').describe('Relative directory path to list. Defaults to workspace root.'),
});

const listFilesTool: AgentTool = {
  name: 'list_files',
  description: 'List files and directories in the agent workspace. Path is relative to the workspace root (default: root). Directories are returned with a trailing slash.',
  parametersSchema: ListFilesParamsSchema,
  parameters: convertZodToJsonSchema(ListFilesParamsSchema),
  category: 'read-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: relativePath } = params as z.infer<typeof ListFilesParamsSchema>;

    const paths = getWorkspacePaths(ctx.agentId);
    await ensureWorkspaceDirs(paths);

    // Empty path means root
    const targetRelative = relativePath || '.';

    let absolutePath: string;
    if (targetRelative === '.') {
      absolutePath = paths.root;
    } else {
      const resolved = await resolveWorkspacePath(paths.root, targetRelative);
      if (!resolved.ok) {
        return { success: false, error: resolved.error, retryable: false };
      }
      absolutePath = resolved.absolutePath;
    }

    try {
      const entries = await readdir(absolutePath, { withFileTypes: true });
      const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      logger.debug({ agentId: ctx.agentId, path: relativePath, count: names.length }, 'list_files success');
      return { success: true, data: { path: relativePath || '/', entries: names } };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { success: false, error: `directory not found: ${relativePath}`, retryable: false };
      }
      if (code === 'ENOTDIR') {
        return { success: false, error: `path is a file, not a directory: ${relativePath}`, retryable: false };
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ agentId: ctx.agentId, path: relativePath, err: msg }, 'list_files error');
      return { success: false, error: `list_files failed: ${msg}`, retryable: false };
    }
  },
};

// --- delete_file ---

const DeleteFileParamsSchema = z.object({
  path: z.string().min(1).describe('Relative path of the file to delete'),
});

const deleteFileTool: AgentTool = {
  name: 'delete_file',
  description: 'Delete a file from the agent workspace. Path is relative to the workspace root. The sandbox directory is reserved and cannot be deleted.',
  parametersSchema: DeleteFileParamsSchema,
  parameters: convertZodToJsonSchema(DeleteFileParamsSchema),
  category: 'write-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: relativePath } = params as z.infer<typeof DeleteFileParamsSchema>;

    const reservedErr = checkReservedDir(relativePath);
    if (reservedErr) {
      return { success: false, error: reservedErr, retryable: false };
    }

    const paths = getWorkspacePaths(ctx.agentId);
    await ensureWorkspaceDirs(paths);

    const resolved = await resolveWorkspacePath(paths.root, relativePath);
    if (!resolved.ok) {
      return { success: false, error: resolved.error, retryable: false };
    }

    try {
      const fileStat = await stat(resolved.absolutePath);
      if (fileStat.isDirectory()) {
        return { success: false, error: 'path is a directory; delete_file only removes files', retryable: false };
      }

      await unlink(resolved.absolutePath);
      logger.debug({ agentId: ctx.agentId, path: relativePath }, 'delete_file success');
      return { success: true, data: { path: relativePath, deleted: true } };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { success: false, error: `file not found: ${relativePath}`, retryable: false };
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ agentId: ctx.agentId, path: relativePath, err: msg }, 'delete_file error');
      return { success: false, error: `delete_file failed: ${msg}`, retryable: false };
    }
  },
};

export const filesystemTools: AgentTool[] = [
  writeFileTool,
  readFileTool,
  listFilesTool,
  deleteFileTool,
];

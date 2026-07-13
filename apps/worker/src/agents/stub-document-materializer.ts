import { mkdir, writeFile, rm } from 'node:fs/promises';
import type {
  RuntimeDocumentMaterializer,
  RuntimeDocumentMaterializerError,
} from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import { getWorkspacePaths } from '../tools/workspace.js';
import { createLogger } from '../logger.js';

const logger = createLogger('stub-document-materializer');

/**
 * Stub / filesystem-backed {@link RuntimeDocumentMaterializer}.
 *
 * Writes document files directly to the agent's workspace directory on disk
 * under `<workspaceRoot>/docs/`. Used when `AGENT_RUNTIME_MODE` is `stub`.
 */
export class StubRuntimeDocumentMaterializer implements RuntimeDocumentMaterializer {
  async materialize(params: {
    agentId: string;
    sessionId: string;
    files: Array<{ relativePath: string; body: Buffer }>;
  }): Promise<{ ok: true; data: void } | { ok: false; error: RuntimeDocumentMaterializerError }> {
    if (params.files.length === 0) {
      return ok(undefined);
    }

    const paths = getWorkspacePaths(params.agentId);

    // Reject path traversal attempts and absolute paths
    for (const file of params.files) {
      if (file.relativePath.includes('..') || file.relativePath.startsWith('/')) {
        return err({
          code: 'runtime_document_materializer.invalid_path',
          message: `Invalid relativePath: "${file.relativePath}"`,
          context: { agentId: params.agentId, sessionId: params.sessionId },
        });
      }
    }

    try {
      // Ensure docs subdirs exist
      await mkdir(`${paths.root}/docs/original`, { recursive: true });
      await mkdir(`${paths.root}/docs/extracted`, { recursive: true });

      for (const file of params.files) {
        const destPath = `${paths.root}/docs/${file.relativePath}`;
        // Ensure parent directory of the file exists
        const lastSlash = destPath.lastIndexOf('/');
        if (lastSlash > 0) {
          await mkdir(destPath.slice(0, lastSlash), { recursive: true });
        }
        await writeFile(destPath, file.body);
      }

      logger.info({ agentId: params.agentId, sessionId: params.sessionId, fileCount: params.files.length }, 'Documents materialized on filesystem');
      return ok(undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.error({ err: cause, agentId: params.agentId, sessionId: params.sessionId }, 'Failed to materialize documents on filesystem');
      return err({
        code: 'runtime_document_materializer.materialize_failed',
        message: `Document materialization failed: ${message}`,
        context: { agentId: params.agentId, sessionId: params.sessionId },
      });
    }
  }

  async cleanup(params: {
    agentId: string;
    sessionId: string;
  }): Promise<{ ok: true; data: void } | { ok: false; error: RuntimeDocumentMaterializerError }> {
    const paths = getWorkspacePaths(params.agentId);
    const docsDir = `${paths.root}/docs`;

    try {
      await rm(docsDir, { recursive: true, force: true });
      logger.info({ agentId: params.agentId, sessionId: params.sessionId }, 'Cleaned up materialized documents');
      return ok(undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.error({ err: cause, agentId: params.agentId, sessionId: params.sessionId }, 'Failed to clean up materialized documents');
      return err({
        code: 'runtime_document_materializer.cleanup_failed',
        message: `Document cleanup failed: ${message}`,
        context: { agentId: params.agentId, sessionId: params.sessionId },
      });
    }
  }
}

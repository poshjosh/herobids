import type {
  RuntimeDocumentMaterializer,
  RuntimeDocumentMaterializerError,
} from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import { createLogger } from '../logger.js';
import { createTarArchive } from '../tar-utils.js';
import { DockerPutArchiveTimeoutError } from './docker-agent-manager.js';

const logger = createLogger('docker-document-materializer');

/**
 * Minimal port for uploading tar archives into a Docker container.
 * Keeps {@link DockerRuntimeDocumentMaterializer} decoupled from the full
 * {@link DockerAgentManager} surface area.
 */
export interface DockerArchivePort {
  putArchive(agentId: string, containerPath: string, tarBuffer: Buffer): Promise<void>;
}

/**
 * Docker-backed {@link RuntimeDocumentMaterializer}.
 *
 * Materializes documents into an agent container by building a tar archive
 * in memory and uploading it via Docker's putArchive API
 * (`PUT /containers/{name}/archive?path=/workspace/docs/`).
 *
 * Cleanup is a no-op because the container's ephemeral workspace is
 * destroyed when the container is removed.
 */
export class DockerRuntimeDocumentMaterializer implements RuntimeDocumentMaterializer {
  constructor(private readonly dockerArchive: DockerArchivePort) {}

  async materialize(params: {
    agentId: string;
    sessionId: string;
    files: Array<{ relativePath: string; body: Buffer }>;
  }): Promise<{ ok: true; data: void } | { ok: false; error: RuntimeDocumentMaterializerError }> {
    if (params.files.length === 0) {
      logger.debug({ agentId: params.agentId, sessionId: params.sessionId }, 'No files to materialize — skipping');
      return ok(undefined);
    }

    // Reject path traversal attempts and absolute paths
    for (const f of params.files) {
      if (f.relativePath.includes('..') || f.relativePath.startsWith('/')) {
        return err({
          code: 'runtime_document_materializer.invalid_path',
          message: `Invalid relativePath: "${f.relativePath}" — must not contain ".." or be absolute`,
          context: { agentId: params.agentId, sessionId: params.sessionId },
        });
      }
    }

    try {
      const tarEntries = params.files.map((f) => ({
        name: `docs/${f.relativePath}`,
        body: f.body,
      }));

      const tarBuffer = createTarArchive(tarEntries);
      logger.debug(
        { agentId: params.agentId, sessionId: params.sessionId, fileCount: params.files.length, tarSize: tarBuffer.length },
        'Created tar archive for document materialization',
      );

      await this.dockerArchive.putArchive(params.agentId, '/workspace/', tarBuffer);

      logger.info({ agentId: params.agentId, sessionId: params.sessionId, fileCount: params.files.length }, 'Documents materialized into agent container');
      return ok(undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.error({ err: cause, agentId: params.agentId, sessionId: params.sessionId }, 'Error during document materialization');

      // Map timeout errors to a specific code
      const isTimeout = cause instanceof DockerPutArchiveTimeoutError;

      return err({
        code: isTimeout
          ? 'runtime_document_materializer.put_archive_timeout'
          : 'runtime_document_materializer.put_archive_failed',
        message: `Document materialization failed: ${message}`,
        context: { agentId: params.agentId, sessionId: params.sessionId },
      });
    }
  }

  async cleanup(_params: {
    agentId: string;
    sessionId: string;
  }): Promise<{ ok: true; data: void } | { ok: false; error: RuntimeDocumentMaterializerError }> {
    // In Docker mode, cleanup is handled by container deletion (ephemeral workspace).
    // The container's /workspace directory is destroyed when the container is removed.
    // If in-session cleanup is ever needed, we can exec `rm -rf /workspace/docs/` here.
    return ok(undefined);
  }
}

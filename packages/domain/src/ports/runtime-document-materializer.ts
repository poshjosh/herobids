import type { Result, DomainError } from '../result.js';

/**
 * Error type for runtime document materialization operations.
 * Dot-namespaced codes, e.g. "runtime_document_materializer.tar_failed".
 */
export interface RuntimeDocumentMaterializerError extends DomainError {
  code: string;
}

/**
 * Abstraction for materializing documents into an agent's runtime filesystem.
 *
 * Each runtime mode (Docker, Stub) provides its own implementation.
 * Documents are placed under `/workspace/docs/` with two sub-directories:
 *   - `docs/original/<document-id>-<sanitized-name>` — original file hierarchy
 *   - `docs/extracted/<document-id>.txt` — extracted plain text
 */
export interface RuntimeDocumentMaterializer {
  /**
   * Write a set of document files into the agent's runtime workspace.
   *
   * The implementation is responsible for translating the logical file list
   * into the runtime's native filesystem access mechanism (Docker putArchive,
   * direct fs writes, etc.).
   */
  materialize(params: {
    agentId: string;
    sessionId: string;
    files: Array<{ relativePath: string; body: Buffer }>;
  }): Promise<Result<void, RuntimeDocumentMaterializerError>>;

  /**
   * Remove materialized documents from the agent's runtime workspace.
   *
   * Best-effort: implementations should not fail if the directory is already
   * absent (ENOENT is treated as success). In Docker mode, cleanup is a no-op
   * because the container deletion wipes /workspace.
   */
  cleanup(params: {
    agentId: string;
    sessionId: string;
  }): Promise<Result<void, RuntimeDocumentMaterializerError>>;
}

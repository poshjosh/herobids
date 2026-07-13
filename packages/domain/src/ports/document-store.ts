import type { Result, DomainError } from '../result.js';

/** Document-store-specific error. */
export interface DocumentStoreError extends DomainError {
  /** e.g. "document_store.not_found", "document_store.write_failed" */
  code: string;
}

/**
 * Abstraction for persisting and retrieving document blobs.
 *
 * Initial implementation: {@link LocalDocumentStore} (filesystem).
 * Future: S3-backed, cloud-with-fallback, etc.
 */
export interface DocumentStore {
  /**
   * Store a document blob and return a store key plus recorded size.
   * The implementation may derive the final key from the hint.
   */
  put(params: {
    keyHint: string;
    contentType: string;
    body: Buffer;
  }): Promise<Result<{ storeKey: string; sizeBytes: number }, DocumentStoreError>>;

  /** Return metadata for a stored object without reading its body. */
  getMetadata(storeKey: string): Promise<Result<{ contentType: string; sizeBytes: number }, DocumentStoreError>>;

  /** Read the full stored object body. */
  read(storeKey: string): Promise<Result<Buffer, DocumentStoreError>>;

  /** Delete a stored object. Must be idempotent (no error if already gone). */
  delete(storeKey: string): Promise<Result<void, DocumentStoreError>>;
}

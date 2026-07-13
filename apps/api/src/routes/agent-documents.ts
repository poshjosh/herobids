import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '@herobids/db';
import { agents, AgentDocumentsRepository } from '@herobids/db';
import { AgentDocumentService } from '@herobids/documents';
import { LocalDocumentStore } from '@herobids/documents/local-document-store';
import { createDocumentTextExtractor } from '@herobids/documents/document-text-extractors';
import { errorPayload } from '../error-payload.js';
import { resolve } from 'node:path';

// ── Constants ───────────────────────────────────────────────────────────────

/** Root directory for agent document files on local disk. */
const AGENT_DOCUMENTS_DIR = process.env['AGENT_DOCUMENTS_DIR'] ?? resolve(process.cwd(), 'data/agent-documents');

// ── Zod schema for multipart file metadata validation ────────────────────────

const uploadFileSchema = z.object({
  fieldname: z.string(),
  filename: z.string().min(1, 'filename is required').max(255),
  mimetype: z.string().min(1, 'mimetype is required'),
  encoding: z.string(),
});

// ── Route module ────────────────────────────────────────────────────────────

export async function agentDocumentRoutes(
  app: FastifyInstance,
  db: Database,
): Promise<void> {
  const repo = new AgentDocumentsRepository(db);
  const store = new LocalDocumentStore(AGENT_DOCUMENTS_DIR);
  const textExtractor = createDocumentTextExtractor();
  const service = new AgentDocumentService(store, textExtractor, repo);

  // ── POST /agents/:id/documents ──────────────────────────────────────────

  app.post<{ Params: { id: string } }>('/agents/:id/documents', async (request, reply) => {
    const { id: agentId } = request.params;

    // Ownership check — verify the agent belongs to the authenticated user
    const [agent] = await db.select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)))
      .limit(1);

    if (!agent) {
      return reply.status(404).send(errorPayload('agent_not_found', 'Agent not found.'));
    }

    // Read the multipart file from the request
    const file = await request.file();
    if (!file) {
      return reply.status(400).send(errorPayload('missing_file', 'No file provided in the upload.'));
    }

    // Validate file metadata with Zod
    const parsed = uploadFileSchema.safeParse({
      fieldname: file.fieldname,
      filename: file.filename,
      mimetype: file.mimetype,
      encoding: file.encoding,
    });
    if (!parsed.success) {
      return reply.status(400).send(errorPayload(
        'invalid_file',
        'Invalid file metadata.',
        parsed.error.flatten() as Record<string, unknown>,
      ));
    }

    // Read the file buffer
    const buffer = await file.toBuffer();

    // Delegate to AgentDocumentService
    const result = await service.uploadDocument({
      agentId,
      userId: request.userId,
      source: 'control_plane',
      originalFilename: file.filename,
      mimeType: file.mimetype,
      body: buffer,
    });

    if (!result.ok) {
      const statusCode = result.error.code === 'agent_document.not_found' ? 404
        : result.error.code === 'agent_document.unsupported_type' ? 400
        : result.error.code === 'agent_document.too_large' ? 413
        : 500;
      return reply.status(statusCode).send(errorPayload(
        result.error.code,
        result.error.message,
        result.error.context,
      ));
    }

    return reply.status(201).send(result.data);
  });

  // ── GET /agents/:id/documents ───────────────────────────────────────────

  app.get<{ Params: { id: string } }>('/agents/:id/documents', async (request, reply) => {
    const { id: agentId } = request.params;

    // Ownership check
    const [agent] = await db.select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)))
      .limit(1);

    if (!agent) {
      return reply.status(404).send(errorPayload('agent_not_found', 'Agent not found.'));
    }

    const docs = await service.getDocuments(agentId);

    return reply.send({
      documents: docs.map((doc) => ({
        id: doc.id,
        agentId: doc.agentId,
        source: doc.source,
        sourceRef: doc.sourceRef,
        originalFilename: doc.originalFilename,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        originalStoreKey: doc.originalStoreKey,
        extractedTextStoreKey: doc.extractedTextStoreKey,
        extractionStatus: doc.extractionStatus,
        lifecycleState: doc.lifecycleState,
        materializedSessionId: doc.materializedSessionId,
        captionOrPrompt: doc.captionOrPrompt,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      })),
    });
  });

  // ── DELETE /agents/:id/documents/:documentId ────────────────────────────

  app.delete<{ Params: { id: string; documentId: string } }>(
    '/agents/:id/documents/:documentId',
    async (request, reply) => {
      const { id: agentId, documentId } = request.params;

      // Ownership check on the agent
      const [agent] = await db.select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)))
        .limit(1);

      if (!agent) {
        return reply.status(404).send(errorPayload('agent_not_found', 'Agent not found.'));
      }

      const result = await service.deleteDocument(agentId, documentId);

      if (!result.ok) {
        const statusCode = result.error.code === 'agent_document.not_found' ? 404 : 403;
        return reply.status(statusCode).send(errorPayload(
          result.error.code,
          result.error.message,
          result.error.context,
        ));
      }

      return reply.status(200).send({ deleted: true });
    },
  );
}

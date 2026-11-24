import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { resolve } from 'node:path';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '@herobids/db';
import { agents, AgentDocumentsRepository } from '@herobids/db';
import { AgentDocumentService, buildDocumentNoticeText, readAgentDocumentPage } from '@herobids/documents';
import { LocalDocumentStore } from '@herobids/documents/local-document-store';
import { createDocumentTextExtractor } from '@herobids/documents/document-text-extractors';
import { errorPayload } from '../error-payload.js';
import { requireSelfAgentOrUser } from '../plugins/auth.js';
import { createConversationRouteDeps, type ConversationRouteDeps } from './conversation-http.js';
import { ChatInboundRouter } from './chat-inbound-router.js';

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
  redisClient: Redis,
  // The default is for tests only. The real caller (apps/api/src/index.ts) must pass the one shared
  // `conversationDeps` it also gives agentInteractivityRoutes and peerThreadRoutes — otherwise this route
  // builds its own ConversationService with schema-default limits instead of appConfig.messaging.conversations,
  // and a second service instance where the rest of the app shares one.
  conversationRouteDeps: ConversationRouteDeps = createConversationRouteDeps(db),
): Promise<void> {
  const repo = new AgentDocumentsRepository(db);
  const store = new LocalDocumentStore(AGENT_DOCUMENTS_DIR);
  const textExtractor = createDocumentTextExtractor();
  const service = new AgentDocumentService(store, textExtractor, repo);
  const conversations = conversationRouteDeps.service;
  const chatRouter = new ChatInboundRouter();

  /**
   * Tells the agent a document exists: records a short, human-readable row in the conversation (what the web
   * thread shows the creator — "Uploaded cv.pdf", not a tool instruction), then publishes the full
   * `read_agent_document` notice to the agent's inbound stream under that row's id, then marks the row's
   * delivery. This mirrors the web-chat attachment path (`agent-interactivity.ts`): the stored row there is
   * the user's own typed caption (or nothing), and the full notice text exists only in the published Redis
   * envelope, never written back to the row. A record failure, or a publish failure (marked `failed` rather
   * than left `queued`), is logged and swallowed — the document is already stored and extracted regardless.
   *
   * The caption is intentionally not shown to the agent a second time as a row body: `recorded.data.message.id`
   * is reused as the published envelope's `messageId` (see `chat-inbound-router.ts`'s `deliver`), and the agent
   * only ever reads the published text. A restart's `hydrateConversationWindow` rebuilds the window purely from
   * stored rows, so after a restart only the caption reappears, not the full notice — the same way a restart
   * loses the full notice text on the chat path too (confirmed in the bug report's investigation).
   * Bug: docs/bug-reports/2026/11/15/003-agent-document-upload-via-control-plane-never-notifies-agent.md
   */
  async function notifyAgentOfDocument(agentId: string, userId: string, documentId: string, filename: string): Promise<void> {
    const caption = `Uploaded ${filename}`;
    const noticeText = buildDocumentNoticeText({ documentId, filename, caption });
    const recorded = await conversations.recordUserMessage({ ownerUserId: userId, agentId, channel: 'web', body: caption });
    if (!recorded.ok) {
      app.log.warn({ agentId, documentId, code: recorded.error.code }, 'Failed to record document notice in agent conversation');
      return;
    }
    const messageId = recorded.data.message.id;
    try {
      await chatRouter.deliver(agentId, userId, noticeText, redisClient, messageId, recorded.data.message.queuedAt);
    } catch (err) {
      app.log.warn({ err, agentId, documentId, messageId }, 'Failed to publish document notice to agent stream');
      const marked = await conversations.markDelivery({ messageId, status: 'failed', detail: 'publish_failed' });
      if (!marked.ok) app.log.warn({ agentId, documentId, code: marked.error.code }, 'could not mark document notice as failed');
      return;
    }
    // One attempt, deliberately: the agent already has the notice (the publish above succeeded), so a failed
    // mark here only means the thread shows "queued" a little longer, not that anything was lost. Telegram's
    // `ChatInboundRouter.markSent` retries 3 times because it is the only record of "did the agent get this";
    // that stronger guarantee isn't needed for a document upload's own row.
    const marked = await conversations.markDelivery({ messageId, status: 'sent' });
    if (!marked.ok) app.log.warn({ agentId, documentId, code: marked.error.code }, 'could not mark document notice as sent');
  }

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

    // Tell the agent this document exists — see notifyAgentOfDocument. Best-effort; the upload already succeeded.
    await notifyAgentOfDocument(agentId, request.userId, result.data.id, result.data.originalFilename);

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

  // ── GET /agents/:id/documents/:documentId/text ──────────────────────────
  // Read by the agent itself (its own key) through the platform client. The agent container has no
  // access to the document store, so the text is served from here. Paged; see readAgentDocumentPage.

  app.get<{ Params: { id: string; documentId: string }; Querystring: { offset?: string } }>(
    '/agents/:id/documents/:documentId/text',
    { config: { agentAccess: 'self' }, preHandler: requireSelfAgentOrUser },
    async (request, reply) => {
      const { id: agentId, documentId } = request.params;
      const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
      if (!Number.isInteger(offset) || offset < 0) {
        return reply.status(400).send(errorPayload('validation_error', 'offset must be a non-negative integer.'));
      }
      if (!z.string().uuid().safeParse(documentId).success) {
        return reply.status(404).send(errorPayload('agent_document.not_found', 'Document not found.'));
      }

      const [agent] = await db.select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)))
        .limit(1);
      if (!agent) {
        return reply.status(404).send(errorPayload('agent_not_found', 'Agent not found.'));
      }

      const result = await readAgentDocumentPage({ lookup: repo, store, agentId, documentId, offset });
      if (!result.ok) {
        const statusCode = result.error.code === 'document.not_found' ? 404
          : result.error.code === 'document.no_text' ? 422
          : result.error.code === 'document.too_large' ? 413
          : 500;
        return reply.status(statusCode).send(errorPayload(result.error.code, result.error.message));
      }
      return reply.send(result.data);
    },
  );

  // ── GET /agents/:id/documents/available ─────────────────────────────────
  // Agent-facing list (own key only) of the documents it can read now: materialized rows only, so
  // staged and deleted rows are excluded. Projected to model-safe fields (no storage keys). Capped
  // at 100 rows with no paging.

  app.get<{ Params: { id: string } }>(
    '/agents/:id/documents/available',
    { config: { agentAccess: 'self' }, preHandler: requireSelfAgentOrUser },
    async (request, reply) => {
      const { id: agentId } = request.params;

      const [agent] = await db.select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)))
        .limit(1);
      if (!agent) {
        return reply.status(404).send(errorPayload('agent_not_found', 'Agent not found.'));
      }

      const docs = await repo.listByAgent(agentId, { lifecycleState: 'materialized', limit: 100 });
      return reply.send({
        documents: docs.map((doc) => ({
          documentId: doc.id,
          filename: doc.originalFilename,
          mimeType: doc.mimeType,
          sizeBytes: doc.sizeBytes,
          lifecycleState: doc.lifecycleState,
          sourceDocumentId: doc.sourceDocumentId,
          source: doc.source,
          extractionStatus: doc.extractionStatus,
        })),
      });
    },
  );

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

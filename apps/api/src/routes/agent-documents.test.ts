import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import type { Redis } from 'ioredis';
import { AGENT_STREAM_MAXLEN } from '@herobids/domain';
import { agentDocumentRoutes } from './agent-documents.js';
import { buildInMemoryConversationDeps } from '../__tests__/helpers/in-memory-conversation-store.js';

const TEST_USER_ID = 'user-1';
const AGENT_ID = 'agent-1';

const uploadDocument = vi.fn();

vi.mock('@herobids/documents', async () => {
  const actual = await vi.importActual<typeof import('@herobids/documents')>('@herobids/documents');
  return {
    ...actual,
    AgentDocumentService: vi.fn().mockImplementation(() => ({
      uploadDocument,
      getDocuments: vi.fn().mockResolvedValue([]),
      deleteDocument: vi.fn(),
    })),
  };
});

vi.mock('@herobids/documents/local-document-store', () => ({
  LocalDocumentStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@herobids/documents/document-text-extractors', () => ({
  createDocumentTextExtractor: vi.fn().mockReturnValue({}),
}));

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
  });
}

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

function buildAgentDb(agent: Record<string, unknown> | null) {
  const rows = agent ? [agent] : [];
  return {
    select: vi.fn().mockImplementation(() => makeChain(rows)),
  } as never;
}

function buildMockRedis(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    xadd: vi.fn().mockResolvedValue('1-1'),
    ...overrides,
  } as unknown as Redis;
}

/** Builds a multipart body with a single file field, matching the shape the route's `request.file()` expects. */
function multipartUpload(file: { name: string; type: string; content: string }) {
  const boundary = 'herobidsTestBoundary';
  const body = `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
    + `Content-Type: ${file.type}\r\n\r\n`
    + `${file.content}\r\n`
    + `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function buildApp(db: unknown, redis: Redis, conversations = buildInMemoryConversationDeps()) {
  const app = Fastify();
  decorateWithAuth(app);
  await app.register(multipart);
  await agentDocumentRoutes(app, db as never, redis, conversations);
  return { app, conversations };
}

describe('POST /agents/:id/documents', () => {
  beforeEach(() => {
    uploadDocument.mockReset();
  });

  it('records a document notice in the conversation and publishes it under the recorded row id', async () => {
    uploadDocument.mockResolvedValue({
      ok: true,
      data: {
        id: 'doc-1',
        originalFilename: 'cv.pdf',
        mimeType: 'application/pdf',
        originalStoreKey: 'doc-1/cv.pdf',
        extractedTextStoreKey: 'doc-1/extracted.txt',
        extractionStatus: 'ready',
        sizeBytes: 123,
        lifecycleState: 'staged',
      },
    });
    const redis = buildMockRedis();
    const { app, conversations } = await buildApp(buildAgentDb({ id: AGENT_ID }), redis);
    const payload = multipartUpload({ name: 'cv.pdf', type: 'application/pdf', content: 'cv contents' });

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/documents`,
      headers: { 'content-type': payload.contentType },
      payload: payload.body,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ id: string }>().id).toBe('doc-1');

    // Recorded as a short, human-readable row — what the web thread shows the creator — not the raw tool notice.
    expect(conversations.store.messages).toHaveLength(1);
    const row = conversations.store.messages[0]!;
    expect(row.senderType).toBe('user');
    expect(row.channel).toBe('web');
    expect(row.body).toBe('Uploaded cv.pdf');
    expect(row.deliveryStatus).toBe('sent');

    // Published to the agent's own inbound stream under that row's id.
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    const call = (redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(`agent:outbound:${AGENT_ID}`);
    expect(call.slice(1, 6)).toEqual(['MAXLEN', '~', AGENT_STREAM_MAXLEN, '*', 'envelope']);
    const envelope = JSON.parse(call[6] as string) as {
      agentId: string;
      messageId: string;
      type: string;
      initiatorType: string;
      initiatorId: string;
      payload: { message: string };
    };
    expect(envelope.agentId).toBe(AGENT_ID);
    expect(envelope.messageId).toBe(row.id);
    expect(envelope.type).toBe('user.message');
    expect(envelope.initiatorType).toBe('user');
    expect(envelope.initiatorId).toBe(TEST_USER_ID);
    expect(envelope.payload.message).toContain('User sent document `cv.pdf` (document id `doc-1`).');
    expect(envelope.payload.message).toContain('read_agent_document');
  });

  it('still returns 201, and marks the notice failed, when the publish fails', async () => {
    uploadDocument.mockResolvedValue({
      ok: true,
      data: {
        id: 'doc-2',
        originalFilename: 'notes.txt',
        mimeType: 'text/plain',
        originalStoreKey: 'doc-2/notes.txt',
        extractedTextStoreKey: null,
        extractionStatus: 'not_needed',
        sizeBytes: 10,
        lifecycleState: 'staged',
      },
    });
    const redis = buildMockRedis({ xadd: vi.fn().mockRejectedValue(new Error('redis down')) });
    const { app, conversations } = await buildApp(buildAgentDb({ id: AGENT_ID }), redis);
    const payload = multipartUpload({ name: 'notes.txt', type: 'text/plain', content: 'hello' });

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/documents`,
      headers: { 'content-type': payload.contentType },
      payload: payload.body,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ id: string }>().id).toBe('doc-2');
    // The row exists (so the gap is visible in the thread/ops data) but is marked failed, not silently lost.
    expect(conversations.store.messages).toHaveLength(1);
    expect(conversations.store.messages[0]!.deliveryStatus).toBe('failed');
  });

  it('does not record or publish a notice when the upload itself fails', async () => {
    uploadDocument.mockResolvedValue({
      ok: false,
      error: { code: 'agent_document.unsupported_type', message: 'nope', context: {} },
    });
    const redis = buildMockRedis();
    const { app, conversations } = await buildApp(buildAgentDb({ id: AGENT_ID }), redis);
    const payload = multipartUpload({ name: 'virus.exe', type: 'application/octet-stream', content: 'x' });

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/documents`,
      headers: { 'content-type': payload.contentType },
      payload: payload.body,
    });

    expect(res.statusCode).toBe(400);
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(conversations.store.messages).toHaveLength(0);
  });

  it('returns 404 and does not call uploadDocument for an agent the user does not own', async () => {
    const redis = buildMockRedis();
    const { app, conversations } = await buildApp(buildAgentDb(null), redis);
    const payload = multipartUpload({ name: 'cv.pdf', type: 'application/pdf', content: 'cv contents' });

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/documents`,
      headers: { 'content-type': payload.contentType },
      payload: payload.body,
    });

    expect(res.statusCode).toBe(404);
    expect(uploadDocument).not.toHaveBeenCalled();
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(conversations.store.messages).toHaveLength(0);
  });
});

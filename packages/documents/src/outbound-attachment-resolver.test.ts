import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { InsertAgentDocument } from '@herobids/db';
import type { DocumentStore, DocumentStoreError, Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import {
  OutboundAttachmentResolver,
  type OutboundDocumentRepository,
  type OutboundDocumentRow,
  type ResolvedAttachment,
} from './outbound-attachment-resolver.js';

const SENDER = 'agent-sender';
const RECIPIENT = 'agent-recipient';
const USER_ID = 'user-1';
const MIB = 1_048_576;

class MemoryDocumentStore implements DocumentStore {
  readonly blobs = new Map<string, { body: Buffer; contentType: string }>();
  readonly reads: string[] = [];
  private sequence = 0;

  async put(params: { keyHint: string; contentType: string; body: Buffer }): Promise<Result<{ storeKey: string; sizeBytes: number }, DocumentStoreError>> {
    this.sequence += 1;
    const storeKey = `${this.sequence}/${params.keyHint}`;
    this.blobs.set(storeKey, { body: params.body, contentType: params.contentType });
    return ok({ storeKey, sizeBytes: params.body.byteLength });
  }

  async getMetadata(storeKey: string): Promise<Result<{ contentType: string; sizeBytes: number }, DocumentStoreError>> {
    const blob = this.blobs.get(storeKey);
    if (!blob) return err(notFound(storeKey));
    return ok({ contentType: blob.contentType, sizeBytes: blob.body.byteLength });
  }

  async read(storeKey: string): Promise<Result<Buffer, DocumentStoreError>> {
    this.reads.push(storeKey);
    const blob = this.blobs.get(storeKey);
    if (!blob) return err(notFound(storeKey));
    return ok(blob.body);
  }

  async delete(storeKey: string): Promise<Result<void, DocumentStoreError>> {
    this.blobs.delete(storeKey);
    return ok(undefined);
  }
}

function notFound(storeKey: string): DocumentStoreError {
  return { code: 'document_store.not_found', message: `Missing ${storeKey}`, context: { storeKey } };
}

class MemoryOutboundRepository implements OutboundDocumentRepository {
  readonly rows = new Map<string, OutboundDocumentRow>();
  readonly inserts: InsertAgentDocument[] = [];
  failCreate = false;
  failCreateAfterInsert = false;
  failHardDelete = false;

  async getById(id: string): Promise<OutboundDocumentRow | null> {
    return this.rows.get(id) ?? null;
  }

  async create(input: InsertAgentDocument): Promise<string> {
    if (this.failCreate) throw new Error('connection reset');
    const id = input.id ?? randomUUID();
    this.inserts.push(input);
    this.rows.set(id, {
      id,
      agentId: input.agentId,
      userId: input.userId,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      originalStoreKey: input.originalStoreKey,
      extractedTextStoreKey: input.extractedTextStoreKey ?? null,
      extractionStatus: input.extractionStatus ?? 'not_needed',
    });
    if (this.failCreateAfterInsert) throw new Error('commit acknowledgement lost');
    return id;
  }

  async hardDelete(id: string): Promise<void> {
    if (this.failHardDelete) throw new Error('connection reset');
    this.rows.delete(id);
  }
}

/** Seeds a stored document the way the upload path leaves it: blobs in the store and a row in the repository. */
async function seedDocument(
  store: MemoryDocumentStore,
  repo: MemoryOutboundRepository,
  overrides: { id?: string; agentId?: string; filename?: string; body?: string; extractedText?: string; sizeBytes?: number } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const body = Buffer.from(overrides.body ?? 'original bytes', 'utf8');
  const original = await store.put({ keyHint: `${id}/file.pdf`, contentType: 'application/pdf', body });
  if (!original.ok) throw new Error('seed failed');
  let extractedTextStoreKey: string | null = null;
  if (overrides.extractedText !== undefined) {
    const text = await store.put({ keyHint: `${id}/extracted.txt`, contentType: 'text/plain; charset=utf-8', body: Buffer.from(overrides.extractedText, 'utf8') });
    if (!text.ok) throw new Error('seed failed');
    extractedTextStoreKey = text.data.storeKey;
  }
  repo.rows.set(id, {
    id,
    agentId: overrides.agentId ?? SENDER,
    userId: USER_ID,
    originalFilename: overrides.filename ?? 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: overrides.sizeBytes ?? body.byteLength,
    originalStoreKey: original.data.storeKey,
    extractedTextStoreKey,
    extractionStatus: extractedTextStoreKey ? 'ready' : 'failed',
  });
  return id;
}

function setup() {
  const store = new MemoryDocumentStore();
  const repo = new MemoryOutboundRepository();
  return { store, repo, resolver: new OutboundAttachmentResolver(store, repo) };
}

describe('OutboundAttachmentResolver.resolveForAgent', () => {
  it('rejects a document owned by another agent without reading any blob', async () => {
    const { store, repo, resolver } = setup();
    const foreignId = await seedDocument(store, repo, { agentId: 'agent-other' });

    const result = await resolver.resolveForAgent(SENDER, [foreignId]);

    expect(result).toMatchObject({ ok: false, error: { code: 'outbound_attachment.not_found' } });
    expect(store.reads).toEqual([]);
  });

  it('rejects a document id that does not exist', async () => {
    const { resolver } = setup();

    const result = await resolver.resolveForAgent(SENDER, [randomUUID()]);

    expect(result).toMatchObject({ ok: false, error: { code: 'outbound_attachment.not_found' } });
  });

  it('rejects a set of documents whose total exceeds 5 MiB before reading any blob', async () => {
    const { store, repo, resolver } = setup();
    const first = await seedDocument(store, repo, { sizeBytes: 3 * MIB });
    const second = await seedDocument(store, repo, { sizeBytes: 3 * MIB });

    const result = await resolver.resolveForAgent(SENDER, [first, second]);

    expect(result).toMatchObject({ ok: false, error: { code: 'outbound_attachment.too_large' } });
    expect(store.reads).toEqual([]);
  });

  it('rejects more than three documents', async () => {
    const { store, repo, resolver } = setup();
    const ids = [
      await seedDocument(store, repo),
      await seedDocument(store, repo),
      await seedDocument(store, repo),
      await seedDocument(store, repo),
    ];

    const result = await resolver.resolveForAgent(SENDER, ids);

    expect(result).toMatchObject({ ok: false, error: { code: 'outbound_attachment.too_many' } });
  });

  it('returns the bytes and metadata without writing a copy', async () => {
    const { store, repo, resolver } = setup();
    const id = await seedDocument(store, repo, { body: 'hello', filename: 'notes.pdf' });
    const blobsBefore = store.blobs.size;

    const result = await resolver.resolveForAgent(SENDER, [id]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ documentId: id, filename: 'notes.pdf', mimeType: 'application/pdf', userId: USER_ID });
    expect(result.data[0]?.body.toString('utf8')).toBe('hello');
    expect(repo.inserts).toEqual([]);
    expect(store.blobs.size).toBe(blobsBefore);
  });
});

describe('OutboundAttachmentResolver.resolveForHuman', () => {
  it('returns the readable documents and reports the missing one instead of failing the set', async () => {
    const { store, repo, resolver } = setup();
    const readableId = await seedDocument(store, repo, { body: 'hello', filename: 'notes.pdf' });
    const missingId = randomUUID();

    const result = await resolver.resolveForHuman(SENDER, [readableId, missingId]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.readable.map((file) => file.documentId)).toEqual([readableId]);
    expect(result.data.unreadable).toEqual([{ documentId: missingId, code: 'outbound_attachment.not_found' }]);
  });

  it('still rejects a set that breaks the document count rule', async () => {
    const { store, repo, resolver } = setup();
    const ids = [
      await seedDocument(store, repo),
      await seedDocument(store, repo),
      await seedDocument(store, repo),
      await seedDocument(store, repo),
    ];

    const result = await resolver.resolveForHuman(SENDER, ids);

    expect(result).toMatchObject({ ok: false, error: { code: 'outbound_attachment.too_many' } });
  });
});

describe('OutboundAttachmentResolver.copyToAgent', () => {
  it('creates an independent copy for the recipient that points back to the original', async () => {
    const { store, repo, resolver } = setup();
    const id = await seedDocument(store, repo, { body: 'source bytes', extractedText: 'extracted text' });
    const resolved = await resolveOne(resolver, id);

    const copy = await resolver.copyToAgent(resolved, RECIPIENT);

    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    expect(copy.data.documentId).not.toBe(id);
    expect(copy.data).toMatchObject({ sourceDocumentId: id, agentId: RECIPIENT });
    expect(repo.inserts).toHaveLength(1);
    expect(repo.inserts[0]).toMatchObject({ id: copy.data.documentId, agentId: RECIPIENT, userId: USER_ID, source: 'agent', sourceDocumentId: id, extractionStatus: 'ready' });
    expect(copy.data.originalStoreKey).not.toBe(resolved.storeKey);
    expect(store.blobs.get(copy.data.originalStoreKey)?.body.toString('utf8')).toBe('source bytes');
    expect(copy.data.extractedTextStoreKey).not.toBeNull();
    expect(store.blobs.get(copy.data.extractedTextStoreKey ?? '')?.body.toString('utf8')).toBe('extracted text');
  });

  it('keeps the copy readable after the sender deletes the original blobs', async () => {
    const { store, repo, resolver } = setup();
    const id = await seedDocument(store, repo, { body: 'source bytes', extractedText: 'extracted text' });
    const resolved = await resolveOne(resolver, id);
    const copy = await resolver.copyToAgent(resolved, RECIPIENT);
    if (!copy.ok) throw new Error('copy failed');

    await store.delete(resolved.storeKey);
    if (resolved.extractedTextStoreKey) await store.delete(resolved.extractedTextStoreKey);

    const readBack = await store.read(copy.data.originalStoreKey);
    expect(readBack.ok && readBack.data.toString('utf8')).toBe('source bytes');
  });

  it('removes the copied blobs and reports copy_failed when the copy cannot be recorded', async () => {
    const { store, repo, resolver } = setup();
    const id = await seedDocument(store, repo, { extractedText: 'extracted text' });
    const resolved = await resolveOne(resolver, id);
    const blobsBefore = store.blobs.size;
    repo.failCreate = true;

    const copy = await resolver.copyToAgent(resolved, RECIPIENT);

    expect(copy).toMatchObject({ ok: false, error: { code: 'outbound_attachment.copy_failed' } });
    expect(store.blobs.size).toBe(blobsBefore);
  });

  it('removes the recorded row, the copied blobs, and reports copy_failed when create commits and then throws', async () => {
    const { store, repo, resolver } = setup();
    const id = await seedDocument(store, repo, { extractedText: 'extracted text' });
    const resolved = await resolveOne(resolver, id);
    const blobsBefore = store.blobs.size;
    repo.failCreateAfterInsert = true;

    const copy = await resolver.copyToAgent(resolved, RECIPIENT);

    expect(copy).toMatchObject({ ok: false, error: { code: 'outbound_attachment.copy_failed' } });
    const copiedId = repo.inserts[0]?.id;
    expect(copiedId).toBeDefined();
    expect(repo.rows.has(copiedId ?? '')).toBe(false);
    expect(store.blobs.size).toBe(blobsBefore);
  });

  it('keeps the copied blobs and reports the orphaned row id when the row cannot be removed after a failed create', async () => {
    const { store, repo, resolver } = setup();
    const id = await seedDocument(store, repo, { extractedText: 'extracted text' });
    const resolved = await resolveOne(resolver, id);
    const blobsBefore = store.blobs.size;
    repo.failCreateAfterInsert = true;
    repo.failHardDelete = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const copy = await resolver.copyToAgent(resolved, RECIPIENT);

    const copiedId = repo.inserts[0]?.id;
    expect(copiedId).toBeDefined();
    expect(copy).toMatchObject({ ok: false, error: { code: 'outbound_attachment.copy_failed', context: { orphanedDocumentId: copiedId } } });
    expect(repo.rows.has(copiedId ?? '')).toBe(true);
    expect(store.blobs.size).toBeGreaterThan(blobsBefore);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[copyToAgent]'));
    warn.mockRestore();
  });
});

describe('OutboundAttachmentResolver.copyAllToAgent', () => {
  it('removes earlier copies and reports copy_failed when a later copy cannot be recorded', async () => {
    const { store, repo, resolver } = setup();
    const first = await seedDocument(store, repo, { extractedText: 'first text' });
    const second = await seedDocument(store, repo, { extractedText: 'second text' });
    const blobsBefore = store.blobs.size;
    const create = repo.create.bind(repo);
    let creates = 0;
    repo.create = async (input) => {
      creates += 1;
      if (creates === 2) throw new Error('connection reset');
      return create(input);
    };
    const resolved = await resolveMany(resolver, [first, second]);

    const copies = await resolver.copyAllToAgent(resolved, RECIPIENT);

    expect(copies).toMatchObject({ ok: false, error: { code: 'outbound_attachment.copy_failed' } });
    expect(repo.inserts).toHaveLength(1);
    expect([...repo.rows.keys()].sort()).toEqual([first, second].sort());
    expect(store.blobs.size).toBe(blobsBefore);
  });

  it('reclaims the row and blobs of a failed copy that committed before it threw', async () => {
    const { store, repo, resolver } = setup();
    const first = await seedDocument(store, repo, { extractedText: 'first text' });
    const second = await seedDocument(store, repo, { extractedText: 'second text' });
    const blobsBefore = store.blobs.size;
    const create = repo.create.bind(repo);
    const hardDelete = repo.hardDelete.bind(repo);
    let creates = 0;
    let deletes = 0;
    repo.create = async (input) => {
      creates += 1;
      const id = await create(input);
      if (creates === 2) throw new Error('commit acknowledgement lost');
      return id;
    };
    repo.hardDelete = async (id) => {
      deletes += 1;
      // The first delete is the failed copy's own cleanup in copyToAgent, so the orphan is left for copyAllToAgent.
      if (deletes === 1) throw new Error('connection reset');
      return hardDelete(id);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = await resolveMany(resolver, [first, second]);

    const copies = await resolver.copyAllToAgent(resolved, RECIPIENT);

    const orphanId = repo.inserts[1]?.id;
    expect(orphanId).toBeDefined();
    expect(copies).toMatchObject({ ok: false, error: { code: 'outbound_attachment.copy_failed', context: { orphanedDocumentId: orphanId } } });
    expect([...repo.rows.keys()].sort()).toEqual([first, second].sort());
    expect(store.blobs.size).toBe(blobsBefore);
    warn.mockRestore();
  });
});

async function resolveMany(resolver: OutboundAttachmentResolver, documentIds: string[]): Promise<ResolvedAttachment[]> {
  const result = await resolver.resolveForAgent(SENDER, documentIds);
  if (!result.ok) throw new Error('resolve failed');
  return result.data;
}

async function resolveOne(resolver: OutboundAttachmentResolver, documentId: string): Promise<ResolvedAttachment> {
  const result = await resolver.resolveForAgent(SENDER, [documentId]);
  if (!result.ok || result.data[0] === undefined) throw new Error('resolve failed');
  return result.data[0];
}

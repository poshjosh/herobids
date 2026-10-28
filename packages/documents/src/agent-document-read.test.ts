import { describe, expect, it, vi } from 'vitest';
import type { DocumentStore } from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import { readAgentDocumentPage, type AgentDocumentRow } from './agent-document-read.js';

const AGENT_ID = 'agent-a';
const DOC_ID = '11111111-1111-4111-8111-111111111111';

function row(overrides: Partial<AgentDocumentRow> = {}): AgentDocumentRow {
  return {
    id: DOC_ID,
    agentId: AGENT_ID,
    originalFilename: 'report.pdf',
    mimeType: 'application/pdf',
    originalStoreKey: 'original-key',
    extractedTextStoreKey: 'extracted-key',
    extractionStatus: 'ready',
    ...overrides,
  };
}

function lookupReturning(document: AgentDocumentRow | null) {
  return { getById: vi.fn(async () => document) };
}

function storeWith(blobs: Record<string, string>, options: { sizeBytes?: number; readFails?: boolean } = {}) {
  const store = {
    put: vi.fn(),
    getMetadata: vi.fn(async (key: string) => (key in blobs
      ? ok({ contentType: 'text/plain', sizeBytes: options.sizeBytes ?? Buffer.byteLength(blobs[key]!) })
      : err({ code: 'document_store.not_found', message: 'missing', context: {} }))),
    read: vi.fn(async (key: string) => (options.readFails
      ? err({ code: 'document_store.read_failed', message: 'disk error', context: {} })
      : key in blobs
        ? ok(Buffer.from(blobs[key]!, 'utf8'))
        : err({ code: 'document_store.not_found', message: 'missing', context: {} }))),
    delete: vi.fn(),
  };
  return store as unknown as DocumentStore & { read: ReturnType<typeof vi.fn>; getMetadata: ReturnType<typeof vi.fn> };
}

describe('readAgentDocumentPage', () => {
  it('returns the extracted text when extraction is ready', async () => {
    const store = storeWith({ 'extracted-key': 'Jesus is Lord\nBody text' });

    const result = await readAgentDocumentPage({
      lookup: lookupReturning(row()), store, agentId: AGENT_ID, documentId: DOC_ID, offset: 0,
    });

    expect(store.read).toHaveBeenCalledWith('extracted-key');
    expect(result).toEqual({
      ok: true,
      data: {
        documentId: DOC_ID,
        filename: 'report.pdf',
        text: 'Jesus is Lord\nBody text',
        offset: 0,
        nextOffset: null,
        totalChars: 23,
      },
    });
  });

  it('falls back to the original file for plain text that has no extraction', async () => {
    const store = storeWith({ 'original-key': 'plain notes' });

    const result = await readAgentDocumentPage({
      lookup: lookupReturning(row({ mimeType: 'text/plain', extractedTextStoreKey: null, extractionStatus: 'not_needed' })),
      store, agentId: AGENT_ID, documentId: DOC_ID, offset: 0,
    });

    expect(store.read).toHaveBeenCalledWith('original-key');
    expect(result).toMatchObject({ ok: true, data: { text: 'plain notes' } });
  });

  it('reports no readable text for a PDF whose extraction failed, without reading the store', async () => {
    const store = storeWith({});

    const result = await readAgentDocumentPage({
      lookup: lookupReturning(row({ extractedTextStoreKey: null, extractionStatus: 'failed' })),
      store, agentId: AGENT_ID, documentId: DOC_ID, offset: 0,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'document.no_text' } });
    expect(store.read).not.toHaveBeenCalled();
  });

  it('reports not found when the document does not exist', async () => {
    const store = storeWith({});

    const result = await readAgentDocumentPage({
      lookup: lookupReturning(null), store, agentId: AGENT_ID, documentId: DOC_ID, offset: 0,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'document.not_found' } });
  });

  it("reports another agent's document as not found, without reading it", async () => {
    const store = storeWith({ 'extracted-key': 'secret' });

    const result = await readAgentDocumentPage({
      lookup: lookupReturning(row({ agentId: 'agent-b' })), store, agentId: AGENT_ID, documentId: DOC_ID, offset: 0,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'document.not_found' } });
    expect(store.read).not.toHaveBeenCalled();
  });

  it('reports a read failure from the store', async () => {
    const store = storeWith({ 'extracted-key': 'text' }, { readFails: true });

    const result = await readAgentDocumentPage({
      lookup: lookupReturning(row()), store, agentId: AGENT_ID, documentId: DOC_ID, offset: 0,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'document.read_failed' } });
  });

  it('refuses a blob over the size cap before reading it', async () => {
    const store = storeWith({ 'extracted-key': 'text' }, { sizeBytes: 10_000 });

    const result = await readAgentDocumentPage({
      lookup: lookupReturning(row()), store, agentId: AGENT_ID, documentId: DOC_ID, offset: 0, maxBytes: 9_999,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'document.too_large' } });
    expect(store.read).not.toHaveBeenCalled();
  });

  it('returns one page and the next offset, so a long document can be read in order', async () => {
    const store = storeWith({ 'extracted-key': 'abcdefghij' });
    const lookup = lookupReturning(row());

    const first = await readAgentDocumentPage({ lookup, store, agentId: AGENT_ID, documentId: DOC_ID, offset: 0, pageChars: 4 });
    const second = await readAgentDocumentPage({ lookup, store, agentId: AGENT_ID, documentId: DOC_ID, offset: 4, pageChars: 4 });
    const third = await readAgentDocumentPage({ lookup, store, agentId: AGENT_ID, documentId: DOC_ID, offset: 8, pageChars: 4 });

    expect(first).toMatchObject({ ok: true, data: { text: 'abcd', nextOffset: 4 } });
    expect(second).toMatchObject({ ok: true, data: { text: 'efgh', nextOffset: 8 } });
    expect(third).toMatchObject({ ok: true, data: { text: 'ij', nextOffset: null, totalChars: 10 } });
  });

  it('never splits a surrogate pair at a page boundary', async () => {
    const store = storeWith({ 'extracted-key': 'a😀b' });
    const lookup = lookupReturning(row());

    const first = await readAgentDocumentPage({ lookup, store, agentId: AGENT_ID, documentId: DOC_ID, offset: 0, pageChars: 2 });
    const second = await readAgentDocumentPage({ lookup, store, agentId: AGENT_ID, documentId: DOC_ID, offset: 2, pageChars: 2 });

    expect(first).toMatchObject({ ok: true, data: { text: 'a😀', nextOffset: 2, totalChars: 3 } });
    expect(second).toMatchObject({ ok: true, data: { text: 'b', nextOffset: null } });
  });

  it('returns an empty page when the offset is past the end', async () => {
    const store = storeWith({ 'extracted-key': 'short' });

    const result = await readAgentDocumentPage({
      lookup: lookupReturning(row()), store, agentId: AGENT_ID, documentId: DOC_ID, offset: 500,
    });

    expect(result).toMatchObject({ ok: true, data: { text: '', offset: 5, nextOffset: null } });
  });
});

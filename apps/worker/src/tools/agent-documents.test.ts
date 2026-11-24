import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@herobids/domain';
import type { AgentPlatformError, AgentPlatformPort, ToolContext } from '@herobids/domain';
import { agentDocumentTools } from './agent-documents.js';

const readTool = agentDocumentTools.find((t) => t.name === 'read_agent_document')!;
const DOC_ID = '11111111-1111-4111-8111-111111111111';

function platformError(code: string, retryable: boolean): AgentPlatformError {
  return { code, message: `${code} message`, retryable };
}

function contextWith(readAgentDocument: AgentPlatformPort['readAgentDocument'] | undefined): ToolContext {
  if (!readAgentDocument) return {} as ToolContext;
  return { agentPlatform: { readAgentDocument } as Partial<AgentPlatformPort> } as ToolContext;
}

describe('read_agent_document', () => {
  it('reports the platform as unavailable when no platform client is configured', async () => {
    const result = await readTool.execute({ documentId: DOC_ID }, contextWith(undefined));

    expect(result).toEqual({
      success: false,
      error: 'document reading unavailable: platform not configured',
      errorCode: 'precondition.not_ready',
      fault: false,
    });
  });

  it('returns the page from the platform, including nextOffset for continuation', async () => {
    const page = { documentId: DOC_ID, filename: 'report.pdf', text: 'Jesus is Lord', offset: 0, nextOffset: 100000, totalChars: 250000 };
    const readAgentDocument = vi.fn(async () => ok(page));

    const result = await readTool.execute({ documentId: DOC_ID }, contextWith(readAgentDocument));

    expect(readAgentDocument).toHaveBeenCalledWith(DOC_ID, 0);
    expect(result).toEqual({ success: true, data: { ok: true, ...page } });
  });

  it('passes the offset through to the platform', async () => {
    const readAgentDocument = vi.fn(async () => ok({ documentId: DOC_ID, filename: 'a.txt', text: '', offset: 500, nextOffset: null, totalChars: 500 }));

    await readTool.execute({ documentId: DOC_ID, offset: 500 }, contextWith(readAgentDocument));

    expect(readAgentDocument).toHaveBeenCalledWith(DOC_ID, 500);
  });

  it('forwards a not-found from the platform as a non-retryable error', async () => {
    const readAgentDocument = vi.fn(async () => err(platformError('agent.platform.not_found', false)));

    const result = await readTool.execute({ documentId: DOC_ID }, contextWith(readAgentDocument));

    expect(result).toEqual({
      success: false,
      error: 'agent.platform.not_found message',
      errorCode: 'agent.platform.not_found',
      fault: false,
    });
  });

  it('marks a retryable platform failure as a fault', async () => {
    const readAgentDocument = vi.fn(async () => err(platformError('agent.platform.unavailable', true)));

    const result = await readTool.execute({ documentId: DOC_ID }, contextWith(readAgentDocument));

    expect(result).toMatchObject({ success: false, fault: true });
  });
});

describe('list_agent_documents', () => {
  const listTool = agentDocumentTools.find((t) => t.name === 'list_agent_documents')!;

  function contextWithPlatform(platform: Partial<AgentPlatformPort>): ToolContext {
    return { agentPlatform: platform as AgentPlatformPort } as ToolContext;
  }

  it('reports the platform as unavailable when no platform client is configured', async () => {
    const result = await listTool.execute({}, {} as ToolContext);

    expect(result).toEqual({
      success: false,
      error: 'document listing unavailable: platform not configured',
      errorCode: 'precondition.not_ready',
      fault: false,
    });
  });

  it('returns the documents the platform lists', async () => {
    const documents = [{
      documentId: DOC_ID,
      filename: 'cv.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 123,
      lifecycleState: 'materialized',
      sourceDocumentId: null,
      source: 'control_plane',
      extractionStatus: 'ready',
    }];
    const listAgentDocuments = vi.fn(async () => ok(documents));

    const result = await listTool.execute({}, contextWithPlatform({ listAgentDocuments }));

    expect(result).toEqual({ success: true, data: { ok: true, documents } });
  });

  it('forwards a platform failure as a fault when retryable', async () => {
    const listAgentDocuments = vi.fn(async () => err(platformError('agent.platform.unavailable', true)));

    const result = await listTool.execute({}, contextWithPlatform({ listAgentDocuments }));

    expect(result).toEqual({
      success: false,
      error: 'agent.platform.unavailable message',
      errorCode: 'agent.platform.unavailable',
      fault: true,
    });
  });

  it('returns documentIds that read_agent_document accepts', async () => {
    const listAgentDocuments = vi.fn(async () => ok([{
      documentId: DOC_ID,
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 9,
      lifecycleState: 'materialized',
      sourceDocumentId: null,
      source: 'control_plane',
      extractionStatus: 'ready',
    }]));
    const readAgentDocument = vi.fn(async () => ok({ documentId: DOC_ID, filename: 'report.pdf', text: 'hi', offset: 0, nextOffset: null, totalChars: 2 }));
    const ctx = contextWithPlatform({ listAgentDocuments, readAgentDocument });

    const listed = await listTool.execute({}, ctx);
    expect(listed.success).toBe(true);
    const listedId = (listed.data as { documents: Array<{ documentId: string }> }).documents[0]!.documentId;

    expect(readTool.parametersSchema.safeParse({ documentId: listedId }).success).toBe(true);
    await readTool.execute({ documentId: listedId }, ctx);
    expect(readAgentDocument).toHaveBeenCalledWith(DOC_ID, 0);
  });
});

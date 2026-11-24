import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { sendEmailTool, initEmailTools } from './email.js';

// Mock the gmail credential resolver so we can control token resolution without a real DB
vi.mock('../gmail-credential-resolver.js', () => ({
  resolveGmailTokens: vi.fn(),
}));

// Mock the gmail adapter so we can control send behaviour without real HTTP calls
vi.mock('../gmail-adapter.js', () => ({
  createGmailAdapter: vi.fn(),
  GmailApiError: class extends Error {
    public code: string;
    public status?: number;
    constructor(code: string, message: string, status?: number) {
      super(message);
      this.name = 'GmailApiError';
      this.code = code;
      this.status = status;
    }
  },
}));

// We import the mocked functions for assertions
import { resolveGmailTokens } from '../gmail-credential-resolver.js';
import { createGmailAdapter } from '../gmail-adapter.js';

const mockResolveGmailTokens = resolveGmailTokens as ReturnType<typeof vi.fn>;
const mockCreateGmailAdapter = createGmailAdapter as ReturnType<typeof vi.fn>;

// Shared port: initEmailTools only takes effect on its first call, so every describe passes this same object.
const outboundPort = {
  prepareForHuman: vi.fn(),
  stageForAgent: vi.fn(),
  markDelivery: vi.fn(),
};
type InitOutboundPort = NonNullable<Parameters<typeof initEmailTools>[2]>;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
      expire: vi.fn(async () => 1),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('send_email documentIds', () => {
  const schema = sendEmailTool.parametersSchema;
  const base = { to: 'test@example.com', subject: 'Report', body: 'See attached' };

  it('accepts up to 3 non-empty document ids', () => {
    expect(schema.safeParse({ ...base, documentIds: ['doc-1'] }).success).toBe(true);
    expect(schema.safeParse({ ...base, documentIds: ['doc-1', 'doc-2', 'doc-3'] }).success).toBe(true);
  });

  it('rejects more than 3 document ids', () => {
    expect(schema.safeParse({ ...base, documentIds: ['a', 'b', 'c', 'd'] }).success).toBe(false);
  });

  it('rejects an empty document id', () => {
    expect(schema.safeParse({ ...base, documentIds: [''] }).success).toBe(false);
  });

  it('parses when documentIds is omitted', () => {
    expect(schema.safeParse(base).success).toBe(true);
  });
});

describe('send_email', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // initEmailTools checks _initialized flag, so we need to re-init each test
    // Use a minimal mock DB — the tool only uses it via resolveGmailTokens
    initEmailTools(
      {} as unknown as Parameters<typeof initEmailTools>[0],
      {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost/callback',
        dailySendLimit: 50,
      },
      outboundPort as unknown as InitOutboundPort,
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ── Schema shape ───────────────────────────────────────────────────────

  it('includes fromConnectionId in the parameters schema (optional)', () => {
    const schema = sendEmailTool.parametersSchema;
    const shape = schema._def.innerType?.shape ?? schema.shape;
    expect(shape).toHaveProperty('fromConnectionId');
    // Optional check: the field should accept undefined
    const parseResult = schema.safeParse({
      to: 'test@example.com',
      subject: 'Test',
      body: 'Hello',
    });
    expect(parseResult.success).toBe(true);
  });

  // ── fromConnectionId validation ────────────────────────────────────────

  it('rejects an invalid fromConnectionId with connection.not_found', async () => {
    mockResolveGmailTokens.mockResolvedValue({
      ok: false,
      error: {
        code: 'connection.not_found',
        message: 'Email connection conn-bogus is not available for this agent.',
      },
    });

    const ctx = makeCtx();

    const result = await sendEmailTool.execute(
      {
        to: 'someone@example.com',
        subject: 'Test',
        body: 'Hello from test',
        fromConnectionId: 'conn-bogus',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('connection.not_found');
    expect(result.error).toContain('conn-bogus');
    // Non-retryable — not a transient failure
    expect(result.retryable).toBe(false);
    expect(mockResolveGmailTokens).toHaveBeenCalledTimes(1);
    expect(mockResolveGmailTokens).toHaveBeenCalledWith(
      expect.anything(),
      'agent-1',
      expect.objectContaining({ clientId: 'test-client-id' }),
      'conn-bogus',
    );
  });

  // ── Missing default connection ─────────────────────────────────────────

  it('returns connection.missing when no email connection is assigned and no fromConnectionId given', async () => {
    mockResolveGmailTokens.mockResolvedValue({
      ok: false,
      error: {
        code: 'connection.missing',
        message: 'No email connection is assigned to this agent.',
      },
    });

    const ctx = makeCtx();

    const result = await sendEmailTool.execute(
      {
        to: 'someone@example.com',
        subject: 'Test',
        body: 'Hello',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('connection.missing');
    expect(result.errorOwner).toBe('user');
    expect(mockResolveGmailTokens).toHaveBeenCalledWith(
      expect.anything(),
      'agent-1',
      expect.anything(),
      undefined, // no fromConnectionId → use default
    );
  });

  // ── Schema validation (param parsing) ──────────────────────────────────

  it('rejects missing required fields', async () => {
    const ctx = makeCtx();

    const result = await sendEmailTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid send_email parameters');
  });

  it('rejects invalid email addresses in to field', async () => {
    const ctx = makeCtx();

    const result = await sendEmailTool.execute(
      {
        to: 'not-an-email',
        subject: 'Test',
        body: 'Hello',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid send_email parameters');
  });

  // ── Happy-path: successful send ────────────────────────────────────────

  it('sends an email successfully when tokens resolve and adapter succeeds', async () => {
    mockResolveGmailTokens.mockResolvedValue({
      ok: true,
      data: {
        accessToken: 'test-token',
        email: 'sender@gmail.com',
        credentialId: 'cred-1',
        connectionId: 'conn-1',
      },
    });

    const mockAdapter = {
      sendEmail: vi.fn().mockResolvedValue({ messageId: 'msg-123', threadId: 'thread-456' }),
    };
    mockCreateGmailAdapter.mockReturnValue(mockAdapter);

    const ctx = makeCtx();

    const result = await sendEmailTool.execute(
      {
        to: 'recipient@example.com',
        subject: 'Test Subject',
        body: 'Test body content',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    if (result.success && result.data) {
      expect(result.data.ok).toBe(true);
      expect(result.data.messageId).toBe('msg-123');
      expect(result.data.threadId).toBe('thread-456');
      expect(result.data.from).toBe('sender@gmail.com');
      expect(result.data.connectionId).toBe('conn-1');
    }

    // Rate limit counter incremented
    const today = new Date().toISOString().slice(0, 10);
    expect(ctx.redis.hset).toHaveBeenCalledWith('gmail:daily_sends', `agent-1:${today}`, '1');
    expect(ctx.redis.expire).toHaveBeenCalledWith('gmail:daily_sends', 86400 * 2);

    // Adapter called with correct params
    expect(mockCreateGmailAdapter).toHaveBeenCalledWith({ accessToken: 'test-token' });
    expect(mockAdapter.sendEmail).toHaveBeenCalledWith({
      to: 'recipient@example.com',
      subject: 'Test Subject',
      body: 'Test body content',
      cc: undefined,
      bcc: undefined,
    });
  });

  it('returns success with fromConnectionId in the response data', async () => {
    mockResolveGmailTokens.mockResolvedValue({
      ok: true,
      data: {
        accessToken: 'test-token',
        email: 'specific-sender@gmail.com',
        credentialId: 'cred-2',
        connectionId: 'conn-specific',
      },
    });

    const mockAdapter = {
      sendEmail: vi.fn().mockResolvedValue({ messageId: 'msg-456', threadId: 'thread-789' }),
    };
    mockCreateGmailAdapter.mockReturnValue(mockAdapter);

    const ctx = makeCtx();

    const result = await sendEmailTool.execute(
      {
        to: 'recipient@example.com',
        subject: 'From Specific Connection',
        body: 'Sent from a specific connection.',
        fromConnectionId: 'conn-specific',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect(result.data.connectionId).toBe('conn-specific');
      expect(result.data.from).toBe('specific-sender@gmail.com');
    }
  });
});

describe('send_email documentIds delivery', () => {
  const base = { to: 'recipient@example.com', subject: 'Report', body: 'See attached' };
  const pdf = {
    auditId: 'audit-1',
    documentId: 'doc-1',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 3,
    body: Buffer.from('abc'),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    initEmailTools(
      {} as unknown as Parameters<typeof initEmailTools>[0],
      { clientId: 'test-client-id', clientSecret: 'test-client-secret', redirectUri: 'http://localhost/callback' },
      outboundPort as unknown as InitOutboundPort,
    );
    mockResolveGmailTokens.mockResolvedValue({
      ok: true,
      data: { accessToken: 'test-token', email: 'sender@gmail.com', credentialId: 'cred-1', connectionId: 'conn-1' },
    });
  });

  it('sends resolved documents as attachments and settles their audit rows as sent', async () => {
    outboundPort.prepareForHuman.mockResolvedValue({ ok: true, data: [pdf] });
    outboundPort.markDelivery.mockResolvedValue({ ok: true, data: undefined });
    const mockAdapter = { sendEmail: vi.fn().mockResolvedValue({ messageId: 'msg-1', threadId: 'thread-1' }) };
    mockCreateGmailAdapter.mockReturnValue(mockAdapter);

    const result = await sendEmailTool.execute({ ...base, documentIds: ['doc-1'] }, makeCtx());

    expect(result.success).toBe(true);
    expect(outboundPort.prepareForHuman).toHaveBeenCalledWith(
      expect.objectContaining({ senderAgentId: 'agent-1', recipientKind: 'email', documentIds: ['doc-1'] }),
    );
    expect(mockAdapter.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [{ filename: 'report.pdf', contentType: 'application/pdf', body: pdf.body }],
      }),
    );
    expect(outboundPort.markDelivery).toHaveBeenCalledWith('audit-1', 'sent', { deliveryRef: 'msg-1' });
  });

  it('settles audit rows as failed when Gmail rejects the send', async () => {
    outboundPort.prepareForHuman.mockResolvedValue({ ok: true, data: [pdf] });
    outboundPort.markDelivery.mockResolvedValue({ ok: true, data: undefined });
    mockCreateGmailAdapter.mockReturnValue({
      sendEmail: vi.fn().mockRejectedValue(Object.assign(new Error('upstream down'), { code: 'gmail.send_failed', status: 500 })),
    });

    const result = await sendEmailTool.execute({ ...base, documentIds: ['doc-1'] }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.fault).toBe(true);
    expect(outboundPort.markDelivery).toHaveBeenCalledWith('audit-1', 'failed', { deliveryError: 'gmail.send_failed' });
  });

  it('keeps email validation errors out of platform faults', async () => {
    outboundPort.prepareForHuman.mockResolvedValue({ ok: true, data: [pdf] });
    outboundPort.markDelivery.mockResolvedValue({ ok: true, data: undefined });
    mockCreateGmailAdapter.mockReturnValue({
      sendEmail: vi.fn().mockRejectedValue(Object.assign(new Error('Attachment rejected'), { code: 'email.invalid_attachment' })),
    });

    const result = await sendEmailTool.execute({ ...base, documentIds: ['doc-1'] }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('email.invalid_attachment');
    expect(result.fault).toBe(false);
    expect(outboundPort.markDelivery).toHaveBeenCalledWith('audit-1', 'failed', { deliveryError: 'email.invalid_attachment' });
  });

  it('returns the document error without contacting Gmail when a document cannot be resolved', async () => {
    outboundPort.prepareForHuman.mockResolvedValue({
      ok: false,
      error: { code: 'outbound_attachment.not_found', message: 'Document not found.' },
    });

    const result = await sendEmailTool.execute({ ...base, documentIds: ['doc-missing'] }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('outbound_attachment.not_found');
    expect(result.fault).toBe(false);
    expect(mockCreateGmailAdapter).not.toHaveBeenCalled();
  });

  it('leaves the send unchanged when documentIds is absent', async () => {
    const mockAdapter = { sendEmail: vi.fn().mockResolvedValue({ messageId: 'msg-2', threadId: 'thread-2' }) };
    mockCreateGmailAdapter.mockReturnValue(mockAdapter);

    const result = await sendEmailTool.execute({ ...base }, makeCtx());

    expect(result.success).toBe(true);
    expect(outboundPort.prepareForHuman).not.toHaveBeenCalled();
    expect(outboundPort.markDelivery).not.toHaveBeenCalled();
    expect(mockAdapter.sendEmail.mock.calls[0]?.[0]).not.toHaveProperty('attachments');
  });
});

import { describe, expect, it } from 'vitest';
import { attachmentProblem, CONVERSATION_ATTACHMENT_MAX_BYTES } from './attachment-rules.js';

describe('attachmentProblem', () => {
  it('accepts a supported type within the size cap', () => {
    expect(attachmentProblem({ type: 'application/pdf', size: 1024 })).toBeNull();
  });

  it('rejects an unsupported type', () => {
    expect(attachmentProblem({ type: 'image/png', size: 1024 })).toBe('unsupported');
  });

  it('rejects a file over the size cap', () => {
    expect(attachmentProblem({ type: 'text/plain', size: CONVERSATION_ATTACHMENT_MAX_BYTES + 1 })).toBe('too_large');
  });
});

import { describe, expect, it } from 'vitest';
import { buildDocumentNoticeText } from './agent-document-notice.js';
import { checkUploadable } from './agent-document-service.js';

describe('buildDocumentNoticeText', () => {
  it('points at the original and extracted copies and includes the caption', () => {
    const text = buildDocumentNoticeText({ documentId: 'doc-1', filename: 'report.pdf', extracted: true, caption: 'Read this' });

    expect(text).toContain('User sent document `report.pdf`.');
    expect(text).toContain('docs/original/doc-1-report.pdf');
    expect(text).toContain('docs/extracted/doc-1.txt');
    expect(text).toContain('Caption: "Read this"');
  });

  it('omits the extracted line and caption when neither applies', () => {
    const text = buildDocumentNoticeText({ documentId: 'doc-2', filename: 'notes.txt', extracted: false });

    expect(text).not.toContain('docs/extracted');
    expect(text).not.toContain('Caption');
  });
});

describe('checkUploadable', () => {
  it('accepts a supported type within the size cap', () => {
    expect(checkUploadable({ mimeType: 'text/csv', sizeBytes: 100, filename: 'a.csv' })).toBeNull();
  });

  it('rejects an unsupported type', () => {
    expect(checkUploadable({ mimeType: 'image/png', sizeBytes: 100, filename: 'a.png' })?.code).toBe('agent_document.unsupported_type');
  });

  it('rejects a file over the size cap', () => {
    expect(checkUploadable({ mimeType: 'text/plain', sizeBytes: 10 * 1_048_576 + 1, filename: 'a.txt' })?.code).toBe('agent_document.too_large');
  });
});

import { describe, expect, it } from 'vitest';
import { buildDocumentNoticeText, parseDocumentNoticeText } from './agent-document-notice.js';
import { checkUploadable } from './agent-document-service.js';

describe('buildDocumentNoticeText', () => {
  it('names the document id, points at the read tool, and includes the caption', () => {
    const text = buildDocumentNoticeText({ documentId: 'doc-1', filename: 'report.pdf', caption: 'Read this' });

    expect(text).toContain('User sent document `report.pdf` (document id `doc-1`).');
    expect(text).toContain('read_agent_document');
    expect(text).not.toContain('docs/');
    expect(text).toContain('Caption: "Read this"');
  });

  it('omits the caption line when there is no caption', () => {
    const text = buildDocumentNoticeText({ documentId: 'doc-2', filename: 'notes.txt' });

    expect(text).not.toContain('Caption');
  });
});

describe('parseDocumentNoticeText', () => {
  it('reads the web shape: the user text, then the notice whose caption repeats it', () => {
    const text = `My CV is attached\n\n${buildDocumentNoticeText({ documentId: 'doc-1', filename: 'cv.pdf', caption: 'My CV is attached' })}`;

    expect(parseDocumentNoticeText(text)).toEqual({ userText: 'My CV is attached', filename: 'cv.pdf', documentId: 'doc-1' });
  });

  it('reads the chat shape: the notice alone, with the caption as the user text', () => {
    const text = buildDocumentNoticeText({ documentId: 'doc-2', filename: 'cv.pdf', caption: 'Please review' });

    expect(parseDocumentNoticeText(text)).toEqual({ userText: 'Please review', filename: 'cv.pdf', documentId: 'doc-2' });
  });

  it('gives empty user text when there is neither text nor caption', () => {
    const text = buildDocumentNoticeText({ documentId: 'doc-3', filename: 'notes.txt' });

    expect(parseDocumentNoticeText(text)).toEqual({ userText: '', filename: 'notes.txt', documentId: 'doc-3' });
  });

  it('returns null for text that is not a notice', () => {
    expect(parseDocumentNoticeText('Hello')).toBeNull();
    expect(parseDocumentNoticeText('User sent document `a.pdf` (document id `x`).')).toBeNull();
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

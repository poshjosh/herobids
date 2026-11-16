import { describe, expect, it } from 'vitest';
import { buildDocumentNoticeText } from '@herobids/documents/agent-document-notice';
import { mergeKnownEntry, preferDocumentNoticeText, type ConversationWindowEntry } from './conversation-window.js';

const ID = 'e65cdb7c-26b9-4334-b1ba-7e86fa6a950a';
const notice = buildDocumentNoticeText({ documentId: ID, filename: 'cv.pdf', caption: 'Uploaded cv.pdf' });
const webNotice = `ok\n\n${buildDocumentNoticeText({ documentId: ID, filename: 'cv.pdf' })}`;

describe('preferDocumentNoticeText', () => {
  it('keeps the live notice when the stored row is only a caption', () => {
    expect(preferDocumentNoticeText('Uploaded cv.pdf', notice)).toBe(notice);
  });

  it('keeps the live notice that follows the user text over a caption row', () => {
    expect(preferDocumentNoticeText('ok', webNotice)).toBe(webNotice);
  });

  it('keeps the stored text when the live text is not a notice', () => {
    expect(preferDocumentNoticeText('hello', 'hello again')).toBe('hello');
  });

  it('keeps the stored notice when both texts are notices', () => {
    const other = buildDocumentNoticeText({ documentId: ID, filename: 'other.pdf' });
    expect(preferDocumentNoticeText(notice, other)).toBe(notice);
  });
});

describe('mergeKnownEntry', () => {
  const caption: ConversationWindowEntry = { id: ID, kind: 'USER', text: 'Uploaded cv.pdf', timestamp: 100 };

  it('replaces a hydrated caption row with the live notice, keeping one entry and its timestamp', () => {
    const entries = [caption];
    const merged = mergeKnownEntry(entries, { id: ID, kind: 'USER', text: notice, timestamp: 200 });
    expect(merged).toEqual([{ id: ID, kind: 'USER', text: notice, timestamp: 100 }]);
    expect(entries[0]?.text).toBe('Uploaded cv.pdf');
  });

  it('returns null for an id the window does not hold', () => {
    expect(mergeKnownEntry([caption], { id: 'other', kind: 'USER', text: notice, timestamp: 200 })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { resolveReplyDelivery } from './fallback-reply.js';

describe('resolveReplyDelivery: tagged replies', () => {
  it('delivers each complete reply block and ignores text outside tags', () => {
    const result = resolveReplyDelivery(
      'Let me think about this first.\n<reply>BTC is up 2%.</reply>\nInternal note.\n<reply>ETH is flat.</reply>',
    );
    expect(result).toEqual({ bodies: ['BTC is up 2%.', 'ETH is flat.'], mode: 'tagged', unclosedTag: false });
  });

  it('ignores an unclosed tag but still delivers complete blocks', () => {
    const result = resolveReplyDelivery('<reply>Done.</reply> <reply>Still work');
    expect(result.bodies).toEqual(['Done.']);
    expect(result.unclosedTag).toBe(true);
  });

  it('does not fall back to untagged delivery when tags are present but all invalid', () => {
    const result = resolveReplyDelivery('<reply><invoke name="get_price"></reply>');
    expect(result.bodies).toEqual([]);
    expect(result.mode).toBe('tagged');
  });

  it('rejects a tagged block that is only whitespace', () => {
    expect(resolveReplyDelivery('<reply>   </reply>').bodies).toEqual([]);
  });
});

describe('resolveReplyDelivery: untagged responses', () => {
  it('delivers the whole response when no reply tag is present', () => {
    expect(resolveReplyDelivery('  Here is the update.  ')).toEqual({
      bodies: ['Here is the update.'],
      mode: 'untagged',
      unclosedTag: false,
    });
  });

  it('rejects empty and whitespace-only text', () => {
    expect(resolveReplyDelivery('').bodies).toEqual([]);
    expect(resolveReplyDelivery('   \n\t ').bodies).toEqual([]);
  });

  it('rejects text longer than the send_message limit', () => {
    expect(resolveReplyDelivery('a'.repeat(2000)).bodies).toHaveLength(1);
    expect(resolveReplyDelivery('a'.repeat(2001)).bodies).toEqual([]);
  });

  it('rejects tool-call and reasoning markup', () => {
    expect(resolveReplyDelivery('Checking now <function_calls>').bodies).toEqual([]);
    expect(resolveReplyDelivery('<invoke name="get_price">').bodies).toEqual([]);
    expect(resolveReplyDelivery('<thinking>draft</thinking>').bodies).toEqual([]);
  });

  it('rejects raw JSON tool-call payloads', () => {
    expect(resolveReplyDelivery('{"tool": "get_price", "args": {}}').bodies).toEqual([]);
    expect(resolveReplyDelivery('{"name": "send_message", "arguments": {}}').bodies).toEqual([]);
  });

  it('keeps ordinary JSON-looking prose', () => {
    expect(resolveReplyDelivery('Your config is {"risk": "low"}.').bodies).toEqual(['Your config is {"risk": "low"}.']);
  });
});

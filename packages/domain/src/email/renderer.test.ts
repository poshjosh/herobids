import { describe, it, expect } from 'vitest';
import { renderEmail, type EmailContent } from './renderer.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeContent(overrides?: Partial<EmailContent>): EmailContent {
  return {
    subject: 'Welcome to OpenAIdom',
    title: 'Get Started',
    body: '<p>Thanks for signing up. We are glad to have you.</p>',
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('renderEmail', () => {
  // -- Output shape ----------------------------------------------------------

  it('returns subject, text, and html', () => {
    const result = renderEmail(makeContent());
    expect(result.subject).toBe('Welcome to OpenAIdom');
    expect(typeof result.text).toBe('string');
    expect(typeof result.html).toBe('string');
  });

  it('passes through the subject unchanged', () => {
    const result = renderEmail(makeContent({ subject: 'Reset your password' }));
    expect(result.subject).toBe('Reset your password');
  });

  // -- Plain-text fallback ---------------------------------------------------

  describe('text output', () => {
    it('includes subject, title, and body', () => {
      const result = renderEmail(makeContent());
      expect(result.text).toContain('Welcome to OpenAIdom');
      expect(result.text).toContain('Get Started');
      expect(result.text).toContain('Thanks for signing up');
    });

    it('includes CTA with arrow indicator and URL', () => {
      const result = renderEmail(
        makeContent({ cta: { text: 'Sign In', url: 'https://example.com/login' } }),
      );
      expect(result.text).toContain('→ Sign In: https://example.com/login');
    });

    it('includes footer note when provided', () => {
      const result = renderEmail(
        makeContent({ footerNote: 'If you did not request this, ignore it.' }),
      );
      expect(result.text).toContain('If you did not request this, ignore it.');
    });

    it('always ends with — OpenAIdom', () => {
      const result = renderEmail(makeContent());
      expect(result.text).toMatch(/— OpenAIdom$/m);
    });

    it('has no CTA block when cta is absent', () => {
      const result = renderEmail(makeContent());
      expect(result.text).not.toContain('→');
    });
  });

  // -- HTML output -----------------------------------------------------------

  describe('html output', () => {
    it('is a complete HTML document', () => {
      const result = renderEmail(makeContent());
      expect(result.html).toMatch(/^<!DOCTYPE html>/);
      expect(result.html).toContain('<html');
      expect(result.html).toContain('</html>');
    });

    it('uses table-based layout', () => {
      const result = renderEmail(makeContent());
      expect(result.html).toContain('<table');
    });

    it('uses brand colors inline', () => {
      const result = renderEmail(makeContent());
      expect(result.html).toContain('#0B1220');
      expect(result.html).toContain('#FFFFFF');
      expect(result.html).toContain('#635BFF');
      expect(result.html).toContain('#101828');
    });

    it('renders the typographic OpenAIdom header with AI in accent color', () => {
      const result = renderEmail(makeContent());
      // Split-color wordmark: Open + AI + dom, only AI is accent-colored
      expect(result.html).toContain('>Open<');
      expect(result.html).toContain('>AI<');
      expect(result.html).toContain('>dom<');
      expect(result.html).toContain('color:#635BFF;');
      expect(result.html).toContain('color:#101828;');
    });

    it('renders title as an h1', () => {
      const result = renderEmail(makeContent({ title: 'Reset Password' }));
      expect(result.html).toContain('<h1');
      expect(result.html).toContain('>Reset Password<');
    });

    it('passes body HTML through unescaped', () => {
      const result = renderEmail(makeContent({ body: '<p>Hello <strong>World</strong></p>' }));
      expect(result.html).toContain('<p>Hello <strong>World</strong></p>');
    });

    it('renders CTA button with brand colors', () => {
      const result = renderEmail(
        makeContent({ cta: { text: 'Sign In', url: 'https://example.com/login' } }),
      );
      expect(result.html).toContain('Sign In');
      expect(result.html).toContain('https://example.com/login');
      expect(result.html).toContain('background-color:#635BFF');
    });

    it('shows fallback URL below CTA button', () => {
      const result = renderEmail(
        makeContent({ cta: { text: 'Click', url: 'https://example.com/verify' } }),
      );
      // The default English fallback text is HTML-escaped in the output
      expect(result.html).toContain("button doesn&#39;t work");
      expect(result.html).toContain('https://example.com/verify');
    });

    it('uses custom ctaFallbackText when provided', () => {
      const result = renderEmail(
        makeContent({
          cta: { text: 'Click', url: 'https://example.com/verify' },
          ctaFallbackText: 'إذا لم يعمل الزر، انسخ والصق هذا الرابط:',
        }),
      );
      expect(result.html).toContain('إذا لم يعمل الزر، انسخ والصق هذا الرابط:');
      expect(result.html).not.toContain("If the button doesn't work");
    });

    it('includes footer note when provided', () => {
      const result = renderEmail(
        makeContent({ footerNote: 'This is an automated message.' }),
      );
      expect(result.html).toContain('This is an automated message.');
    });

    it('always includes — OpenAIdom in footer', () => {
      const result = renderEmail(makeContent());
      expect(result.html).toContain('— OpenAIdom');
    });

    it('does not include CTA markup when cta is absent', () => {
      const result = renderEmail(makeContent());
      expect(result.html).not.toContain("If the button doesn't work");
    });
  });

  // -- Preheader -------------------------------------------------------------

  describe('preheader', () => {
    it('includes hidden preheader text when provided', () => {
      const result = renderEmail(makeContent({ preheader: 'Your account is ready' }));
      expect(result.html).toContain('Your account is ready');
      expect(result.html).toContain('mso-hide:all');
    });

    it('omits preheader markup when not provided', () => {
      const result = renderEmail(makeContent());
      // Should not have the MSO-hide preheader div structure
      expect(result.html).not.toContain('mso-hide:all');
    });
  });

  // -- Brand image -----------------------------------------------------------

  describe('brand image', () => {
    it('renders img tag when brandImageUrl is provided', () => {
      const result = renderEmail(
        makeContent({ brandImageUrl: 'https://cdn.example.com/logo.png' }),
      );
      expect(result.html).toContain('<img');
      expect(result.html).toContain('https://cdn.example.com/logo.png');
    });

    it('places image above the typographic header', () => {
      const result = renderEmail(
        makeContent({ brandImageUrl: 'https://cdn.example.com/logo.png' }),
      );
      const imgIdx = result.html.indexOf('<img');
      const openIdx = result.html.indexOf('>Open<');
      expect(imgIdx).toBeGreaterThan(0);
      expect(openIdx).toBeGreaterThan(0);
      expect(imgIdx).toBeLessThan(openIdx);
    });

    it('omits img tag when brandImageUrl is not provided', () => {
      const result = renderEmail(makeContent());
      expect(result.html).not.toContain('<img');
    });
  });

  // -- HTML escaping (non-body fields) ---------------------------------------

  describe('HTML escaping', () => {
    it('escapes special characters in subject within HTML title tag', () => {
      const result = renderEmail(makeContent({ subject: 'Alert: Price < $5 & "special" > deal' }));
      // The <title> tag content should be escaped
      expect(result.html).toContain('&lt;');
      expect(result.html).toContain('&gt;');
      expect(result.html).toContain('&quot;');
      expect(result.html).toContain('&amp;');
    });

    it('escapes special characters in title h1', () => {
      const result = renderEmail(makeContent({ title: 'Price < $10 & "deal"' }));
      expect(result.html).toContain('Price &lt; $10 &amp; &quot;deal&quot;');
    });

    it('escapes special characters in CTA text and URL', () => {
      const result = renderEmail(
        makeContent({
          cta: { text: 'Click "Here"', url: 'https://example.com?a=1&b=2' },
        }),
      );
      expect(result.html).toContain('Click &quot;Here&quot;');
      expect(result.html).toContain('a=1&amp;b=2');
    });

    it('does NOT escape body HTML', () => {
      const result = renderEmail(
        makeContent({ body: '<p>Price < $5 &amp; <strong>"deal"</strong></p>' }),
      );
      // Body is inserted verbatim — the caller is responsible for escaping
      expect(result.html).toContain('<p>Price < $5 &amp; <strong>"deal"</strong></p>');
    });
  });

  // -- RTL / locale support ---------------------------------------------------

  describe('locale and direction', () => {
    it('renders dir="rtl" and lang="ar" for Arabic locale', () => {
      const result = renderEmail(makeContent({ locale: 'ar' }));
      expect(result.html).toContain('lang="ar"');
      expect(result.html).toContain('dir="rtl"');
      expect(result.html).toContain('direction:rtl');
      expect(result.html).toContain('text-align:start');
    });

    it('renders dir="ltr" and lang="hi" for Hindi locale', () => {
      const result = renderEmail(makeContent({ locale: 'hi' }));
      expect(result.html).toContain('lang="hi"');
      expect(result.html).toContain('dir="ltr"');
      expect(result.html).toContain('direction:ltr');
    });

    it('defaults to dir="ltr" and lang="en" when locale is not provided', () => {
      const result = renderEmail(makeContent());
      expect(result.html).toContain('lang="en"');
      expect(result.html).toContain('dir="ltr"');
      expect(result.html).toContain('direction:ltr');
    });

    it('adds dir="ltr" to the brand wordmark span for correct rendering in RTL', () => {
      const result = renderEmail(makeContent({ locale: 'ar' }));
      expect(result.html).toMatch(/dir="ltr"[^>]*>.*Open.*AI.*dom/s);
    });
  });

  // -- Edge cases ------------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty body', () => {
      const result = renderEmail(makeContent({ body: '' }));
      expect(result.subject).toBe('Welcome to OpenAIdom');
      expect(result.text).toContain('Get Started');
    });

    it('handles very long subject', () => {
      const longSubject = 'A'.repeat(200);
      const result = renderEmail(makeContent({ subject: longSubject }));
      expect(result.subject).toBe(longSubject);
      expect(result.text).toContain(longSubject);
    });

    it('handles CTA with long URL', () => {
      const longUrl = 'https://example.com/' + 'x'.repeat(500);
      const result = renderEmail(
        makeContent({ cta: { text: 'Go', url: longUrl } }),
      );
      expect(result.html).toContain(longUrl);
      expect(result.text).toContain(longUrl);
    });

    it('handles multiline body in text output', () => {
      const result = renderEmail(makeContent({ body: 'Line 1\nLine 2\nLine 3' }));
      expect(result.text).toContain('Line 1\nLine 2\nLine 3');
    });
  });
});

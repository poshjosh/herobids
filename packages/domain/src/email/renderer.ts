// ---------------------------------------------------------------------------
// Shared branded email renderer — pure function, no I/O, no dependencies.
//
// Produces inline-styled HTML and a plain-text fallback for platform emails
// (auth, billing, safety).  Both apps/api and apps/worker import this.
// ---------------------------------------------------------------------------

// ── Public types ───────────────────────────────────────────────────────────

export interface EmailContent {
  subject: string;
  /** Preview text shown in the inbox (optional). */
  preheader?: string;
  /** Main heading inside the email body. */
  title: string;
  /**
   * Body content — plain text or simple, already-escaped HTML fragments.
   * Safe tags: <p>, <br>, <strong>, <em>, <a>, <ul>, <ol>, <li>.
   * The renderer does NOT escape this field — treat it as trusted HTML.
   */
  body: string;
  /** Optional call-to-action button. */
  cta?: { text: string; url: string };
  /** Localized fallback text shown below the CTA button (defaults to English). */
  ctaFallbackText?: string;
  /** Optional footer note (e.g. "If you did not request this…"). */
  footerNote?: string;
  /**
   * Optional absolute URL to a brand logo image.
   * When set, the image is rendered above the typographic header.
   */
  brandImageUrl?: string;
  /** BCP-47 locale code for language/direction. Defaults to 'en'. */
  locale?: string;
}

export interface RenderedEmail {
  subject: string;
  /** Plain-text fallback with clear hierarchy. */
  text: string;
  /** Branded, inline-styled HTML for email clients. */
  html: string;
}

// ── Brand palette (from OpenAIdom brand spec) ──────────────────────────────

const BRAND = {
  background: '#0B1220',
  cardBg: '#FFFFFF',
  headerText: '#635BFF',
  bodyText: '#101828',
  ctaBg: '#635BFF',
  ctaText: '#FFFFFF',
  footerText: '#6B7280',
  border: '#E5E7EB',
} as const;

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// ── RTL locales ────────────────────────────────────────────────────────────

const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur']);

function resolveDir(locale: string): 'rtl' | 'ltr' {
  return RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Escape text for use inside HTML element content. */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wrap a URL with a tracking-safe redirect.
 *  TODO(002-openaidom-brand-rollout): implement redirect wrapping / URL signing
 *  before production email delivery goes live. */
function safeUrl(url: string): string {
  return url;
}

// ── Plain-text renderer ────────────────────────────────────────────────────

function renderText(content: EmailContent): string {
  const lines: string[] = [];

  lines.push(content.subject);
  lines.push('='.repeat(content.subject.length));
  lines.push('');
  lines.push(content.title);
  lines.push('-'.repeat(content.title.length));
  lines.push('');
  lines.push(content.body);

  if (content.cta) {
    lines.push('');
    lines.push(`→ ${content.cta.text}: ${content.cta.url}`);
  }

  if (content.footerNote) {
    lines.push('');
    lines.push('---');
    lines.push(content.footerNote);
  }

  lines.push('');
  lines.push('— OpenAIdom');

  return lines.join('\n');
}

// ── HTML renderer ──────────────────────────────────────────────────────────

function renderHtml(content: EmailContent): string {
  const locale = content.locale ?? 'en';
  const dir = resolveDir(locale);

  const preheader = content.preheader
    ? `\n    <!--[if !mso]><!-- --><div style="display:none;font-size:1px;color:#0B1220;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;mso-hide:all;">${htmlEscape(content.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div><!--<![endif]-->`
    : '';

  const brandImage = content.brandImageUrl
    ? `\n              <img src="${htmlEscape(content.brandImageUrl)}" alt="OpenAIdom" width="180" style="display:block;max-width:180px;height:auto;margin:0 auto 16px auto;border:0;outline:none;">`
    : '';

  const ctaBlock = content.cta
    ? `
            <tr>
              <td align="center" style="padding:0 40px 16px 40px;">
                <!--[if mso]>
                <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${htmlEscape(safeUrl(content.cta.url))}" style="height:44px;v-text-anchor:middle;width:200px;" arcsize="14%" strokecolor="${BRAND.ctaBg}" fillcolor="${BRAND.ctaBg}">
                <w:anchorlock/>
                <center style="color:${BRAND.ctaText};font-family:${FONT_STACK};font-size:16px;font-weight:600;">${htmlEscape(content.cta.text)}</center>
                </v:roundrect>
                <![endif]-->
                <!--[if !mso]><!-- -->
                <a href="${htmlEscape(safeUrl(content.cta.url))}" target="_blank" style="display:inline-block;background-color:${BRAND.ctaBg};color:${BRAND.ctaText};text-decoration:none;padding:12px 32px;border-radius:6px;font-family:${FONT_STACK};font-size:16px;font-weight:600;mso-hide:all;">${htmlEscape(content.cta.text)}</a>
                <!--<![endif]-->
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 40px 24px 40px;">
                <p style="font-family:${FONT_STACK};font-size:13px;color:${BRAND.footerText};margin:0;word-break:break-all;">
                  ${htmlEscape(content.ctaFallbackText ?? "If the button doesn't work, copy and paste this link:")}<br>
                  <a href="${htmlEscape(safeUrl(content.cta.url))}" style="color:${BRAND.footerText};text-decoration:underline;">${htmlEscape(content.cta.url)}</a>
                </p>
              </td>
            </tr>`
    : '';

  const footerNoteBlock = content.footerNote
    ? `\n              <p style="font-family:${FONT_STACK};font-size:13px;color:${BRAND.footerText};margin:0 0 8px 0;">${htmlEscape(content.footerNote)}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="${locale}" dir="${dir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${htmlEscape(content.subject)}</title>${preheader}
</head>
<body style="margin:0;padding:0;background-color:${BRAND.background};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;direction:${dir};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.background};">
    <tr>
      <td align="center" style="padding:40px 20px;text-align:start;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:${BRAND.cardBg};border-radius:8px;">
          <!-- Header -->
          <tr>
            <td align="center" style="padding:32px 40px 0 40px;">${brandImage}
              <span dir="ltr" style="font-family:${FONT_STACK};font-size:24px;font-weight:700;letter-spacing:-0.5px;"><span style="color:${BRAND.bodyText};">Open</span><span style="color:${BRAND.headerText};">AI</span><span style="color:${BRAND.bodyText};">dom</span></span>
            </td>
          </tr>
          <!-- Title -->
          <tr>
            <td style="padding:24px 40px 0 40px;text-align:start;">
              <h1 style="font-family:${FONT_STACK};font-size:20px;font-weight:600;color:${BRAND.bodyText};margin:0;line-height:1.4;">${htmlEscape(content.title)}</h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:16px 40px 8px 40px;font-family:${FONT_STACK};font-size:16px;line-height:1.6;color:${BRAND.bodyText};text-align:start;">
              ${content.body}
            </td>
          </tr>${ctaBlock}
          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px 32px 40px;border-top:1px solid ${BRAND.border};text-align:start;">${footerNoteBlock}
              <p style="font-family:${FONT_STACK};font-size:13px;color:${BRAND.footerText};margin:0;">— OpenAIdom</p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Render a branded platform email from structured content.
 *
 * Pure function — no side effects, no I/O, no config loading.
 * Both `apps/api` and `apps/worker` can import and use this directly.
 *
 * @returns A {@link RenderedEmail} with subject, plain-text fallback, and
 *          inline-styled HTML ready for SES / SMTP delivery.
 */
export function renderEmail(content: EmailContent): RenderedEmail {
  return {
    subject: content.subject,
    text: renderText(content),
    html: renderHtml(content),
  };
}

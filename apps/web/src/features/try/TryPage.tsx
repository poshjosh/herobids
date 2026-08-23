import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useIntl } from 'react-intl';
import { isAuthenticated } from '../../lib/session.js';
import { auth, ApiError } from '../../lib/api-client.js';
import { BrandLogo } from '../../brand/BrandLogo.js';

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Timing (ms)
// ---------------------------------------------------------------------------

const MESSAGE_1_TYPING_DURATION = 2000; // typing indicator visible for 2 s alongside message 1, then message 2 appears

// ---------------------------------------------------------------------------
// State machine phases
// ---------------------------------------------------------------------------

type Phase =
  | 'IDLE'
  | 'MESSAGE_1'
  | 'MESSAGE_2'
  | 'SENDING_LINK'
  | 'LINK_SENT'
  | 'RESENDING'
  | 'ERROR';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TryPage() {
  const navigate = useNavigate();
  const intl = useIntl();

  // Redirect authenticated users to guided chat
  useEffect(() => {
    if (isAuthenticated()) {
      navigate('/agents/new?ui=chat', { replace: true });
    }
  }, [navigate]);

  const [phase, setPhase] = useState<Phase>('IDLE');
  const [email, setEmail] = useState('');
  const [validationError, setValidationError] = useState('');
  const [serverError, setServerError] = useState('');
  const [hasLinkBeenSent, setHasLinkBeenSent] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Typing animation sequence ──────────────────────────────────────────

  useEffect(() => {
    if (phase !== 'IDLE') return;

    // Message 1 appears immediately; typing indicator shows alongside it.
    setPhase('MESSAGE_1');
  }, [phase]);

  useEffect(() => {
    if (phase !== 'MESSAGE_1') return;

    const t = setTimeout(() => {
      setPhase('MESSAGE_2');
      // Focus the email input after it appears
      setTimeout(() => emailInputRef.current?.focus(), 50);
    }, MESSAGE_1_TYPING_DURATION);
    return () => clearTimeout(t);
  }, [phase]);

  // ── Auto-scroll when phase changes ────────────────────────────────────

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [phase]);

  // ── Email input handlers ───────────────────────────────────────────────

  const validate = useCallback((value: string): boolean => {
    if (!EMAIL_REGEX.test(value)) {
      setValidationError(intl.formatMessage({ id: 'try.validationError' }));
      return false;
    }
    setValidationError('');
    return true;
  }, [intl]);

  const handleEmailChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setEmail(value);
      setServerError('');
      // Clear validation error once the value looks valid
      if (validationError && EMAIL_REGEX.test(value)) {
        setValidationError('');
      }
    },
    [validationError],
  );

  const sendLink = useCallback(
    async (emailToSend: string) => {
      setServerError('');
      try {
        await auth.sendLoginLink(emailToSend, undefined, '/agents/new?ui=chat');
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          setServerError(intl.formatMessage({ id: 'try.errorRateLimit' }));
        } else {
          setServerError(intl.formatMessage({ id: 'try.errorGeneric' }));
        }
        return { ok: false };
      }
    },
    [intl],
  );

  // ── Phase-derived flags (must be above handleSubmit / handleKeyDown) ────

  const isEmailSubmitting = phase === 'SENDING_LINK';
  const isResending = phase === 'RESENDING';

  const handleSubmit = useCallback(async () => {
    const trimmed = email.trim();
    if (!validate(trimmed)) return;
    setEmail(trimmed);
    setPhase('SENDING_LINK');
    const result = await sendLink(trimmed);
    if (result.ok) {
      setHasLinkBeenSent(true);
      setPhase('LINK_SENT');
    } else {
      setPhase('ERROR');
    }
  }, [email, validate, sendLink]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (isEmailSubmitting) return;
        void handleSubmit();
      }
    },
    [handleSubmit, isEmailSubmitting],
  );

  const handleResend = useCallback(async () => {
    setPhase('RESENDING');
    const result = await sendLink(email);
    if (result.ok) {
      setPhase('LINK_SENT');
    } else {
      setPhase('ERROR');
    }
  }, [email, sendLink, isResending]);

  const showMessage1 = phase !== 'IDLE';
  const showTyping = phase === 'MESSAGE_1';
  const showMessage2 =
    phase === 'MESSAGE_2' || phase === 'SENDING_LINK' || phase === 'LINK_SENT' ||
    phase === 'RESENDING' || phase === 'ERROR';
  const showEmailInput = phase === 'MESSAGE_2' || phase === 'SENDING_LINK' || (phase === 'ERROR' && !hasLinkBeenSent);
  const showMessage3 = phase === 'LINK_SENT' || phase === 'RESENDING' || (phase === 'ERROR' && hasLinkBeenSent);
  const showResend = phase === 'LINK_SENT' || phase === 'RESENDING' || (phase === 'ERROR' && hasLinkBeenSent);

  return (
    <div className="try-page">
      {/* Header */}
      <div className="try-page-header">
        <BrandLogo display="full" variant="dark" size="md" linkTo="/" />
      </div>

      {/* Scrollable message area */}
      <div ref={scrollRef} className="try-page-scroll">
        {/* Message 1 */}
        {showMessage1 && (
          <div className="try-page-message-row">
            <div className="try-page-bubble">{intl.formatMessage({ id: 'try.message1' })}</div>
          </div>
        )}

        {/* Typing indicator — shown alongside message 1 while composing message 2 */}
        {showTyping && (
          <div className="try-page-typing">
            <span className="try-page-typing-dot">●</span>
            {intl.formatMessage({ id: 'try.typing' })}
          </div>
        )}

        {/* Message 2 */}
        {showMessage2 && (
          <div className="try-page-message-row">
            <div className="try-page-bubble">{intl.formatMessage({ id: 'try.message2' })}</div>
          </div>
        )}

        {/* Email input (below message 2) */}
        {showEmailInput && (
          <div className="try-page-input-wrapper">
            <div className="try-page-input-row">
              <input
                ref={emailInputRef}
                type="email"
                value={email}
                onChange={handleEmailChange}
                onKeyDown={handleKeyDown}
                placeholder="you@example.com"
                disabled={isEmailSubmitting}
                className="try-page-input"
                autoComplete="email"
              />
              <button
                onClick={() => void handleSubmit()}
                disabled={isEmailSubmitting || !email.trim()}
                className="try-page-send-btn"
              >
                {isEmailSubmitting ? '...' : intl.formatMessage({ id: 'try.send' })}
              </button>
            </div>
            {validationError && <div className="try-page-error">{validationError}</div>}
            {serverError && !validationError && <div className="try-page-error">{serverError}</div>}
          </div>
        )}

        {/* Message 3 (after link sent) */}
        {showMessage3 && (
          <div className="try-page-message-row">
            <div className="try-page-bubble">{intl.formatMessage({ id: 'try.message3' }, { email })}</div>
          </div>
        )}

        {/* Resend button */}
        {showResend && (
          <div className="try-page-resend-wrapper">
            <div className="try-page-resend-row">
              {serverError && phase === 'ERROR' && (
                <div className="try-page-error try-page-resend-error">{serverError}</div>
              )}
              <button
                onClick={() => void handleResend()}
                disabled={isResending}
                className="try-page-resend-btn"
              >
                {isResending ? intl.formatMessage({ id: 'try.resending' }) : intl.formatMessage({ id: 'try.resendLink' })}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

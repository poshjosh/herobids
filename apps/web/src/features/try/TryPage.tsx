import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { isAuthenticated } from '../../lib/session.js';
import { auth, ApiError } from '../../lib/api-client.js';
import { BrandLogo } from '../../brand/BrandLogo.js';

// ---------------------------------------------------------------------------
// Static copy
// ---------------------------------------------------------------------------

const MESSAGE_1 = "Hi! I can help you create an AI agent. Let's get you set up first.";
const MESSAGE_2 =
  'I see you have not logged in, please provide your email address so your AI agents can communicate with you';
const MESSAGE_3 = (email: string) =>
  `An email has been sent to ${email}. Check your inbox — the link will set you up for a new AI agent.`;

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

  // Redirect authenticated users to /agents/new
  useEffect(() => {
    if (isAuthenticated()) {
      navigate('/agents/new', { replace: true });
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
      setValidationError('Enter a valid email address');
      return false;
    }
    setValidationError('');
    return true;
  }, []);

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
        await auth.sendLoginLink(emailToSend, undefined, '/agents/new');
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          setServerError('Please wait before requesting another link');
        } else {
          setServerError('Something went wrong. Please try again.');
        }
        return { ok: false };
      }
    },
    [],
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
            <div className="try-page-bubble">{MESSAGE_1}</div>
          </div>
        )}

        {/* Typing indicator — shown alongside message 1 while composing message 2 */}
        {showTyping && (
          <div className="try-page-typing">
            <span className="try-page-typing-dot">●</span>
            Assistant is typing...
          </div>
        )}

        {/* Message 2 */}
        {showMessage2 && (
          <div className="try-page-message-row">
            <div className="try-page-bubble">{MESSAGE_2}</div>
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
                {isEmailSubmitting ? '...' : 'Send'}
              </button>
            </div>
            {validationError && <div className="try-page-error">{validationError}</div>}
            {serverError && !validationError && <div className="try-page-error">{serverError}</div>}
          </div>
        )}

        {/* Message 3 (after link sent) */}
        {showMessage3 && (
          <div className="try-page-message-row">
            <div className="try-page-bubble">{MESSAGE_3(email)}</div>
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
                {isResending ? 'Resending...' : 'Resend link'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

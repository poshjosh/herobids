import { useState, useRef, useEffect } from 'react';
import { Link, Navigate } from 'react-router';
import { useIntl } from 'react-intl';
import { useSession } from '../../app/providers/SessionProvider.js';
import { LoadingSpinner } from '../../app/layout/RootLayout.js';
import { BrandLogo } from '../../brand/BrandLogo.js';
import { PublicFooter } from '../public-pages/PublicLayout.js';
import { useLocale } from '../../app/i18n/I18nProvider.js';
import { LocalePickerButton } from '../../lib/LocalePickerButton.js';

export function LandingPagePlaceholder() {
  const { user, loading } = useSession();
  const { locale } = useLocale();
  const intl = useIntl();
  const [letterOpen, setLetterOpen] = useState(false);
  const letterRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (letterOpen && letterRef.current) {
      letterRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [letterOpen]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <LoadingSpinner />
      </div>
    );
  }

  // Authenticated users go to /agents
  if (user) {
    return <Navigate to="/agents" replace />;
  }

  // Unauthenticated visitors see the landing page
  return (
    <div className="landing-page landing-page--image">
      <div style={{ position: 'absolute', top: '16px', right: '24px', zIndex: 10 }}>
        <LocalePickerButton />
      </div>
      <div className="landing-page-row">
        <div className="landing-page-hero">
          <div className="landing-page-card">
            <BrandLogo display="full" variant="dark" size="lg" />
            <p className="landing-page-tagline">
              {intl.formatMessage({ id: 'landing.tagline' })}
            </p>
            <p className="landing-page-description">
              {intl.formatMessage({ id: 'landing.description' })}
            </p>
            <div className="landing-page-ctas">
              <Link to="/login" className="landing-page-cta">
                {intl.formatMessage({ id: 'landing.signIn' })}
              </Link>
              <Link to="/try" className="landing-page-cta">
                {intl.formatMessage({ id: 'landing.tryIt' })}
              </Link>
            </div>
          </div>
        </div>

        <div className="landing-page-proofs">
          <div className="landing-page-proof">
            <p className="landing-page-proof-heading">{intl.formatMessage({ id: 'landing.proof.cost.heading' })}</p>
            <p className="landing-page-proof-text">
              {intl.formatMessage({ id: 'landing.proof.cost.text' })}
            </p>
            <Link to="/docs/agents/how-agent-costs-are-kept-low" className="landing-page-proof-link">
              {intl.formatMessage({ id: 'landing.proof.cost.link' })}
            </Link>
          </div>

          <div className="landing-page-proof">
            <p className="landing-page-proof-heading">{intl.formatMessage({ id: 'landing.proof.oneClick.heading' })}</p>
            <p className="landing-page-proof-text">
              {intl.formatMessage({ id: 'landing.proof.oneClick.text' })}
            </p>
            <Link to="/try" className="landing-page-proof-link">
              {intl.formatMessage({ id: 'landing.proof.oneClick.link' })}
            </Link>
          </div>
        </div>
      </div>

      <button
        className="landing-page-letter-toggle"
        onClick={() => setLetterOpen((v) => !v)}
        aria-expanded={letterOpen}
      >
        {intl.formatMessage({ id: 'landing.letter.toggle' })}
      </button>

      {letterOpen && (
      <section className="landing-page-about" ref={letterRef}>
        <h2 className="landing-page-about-heading">{intl.formatMessage({ id: 'landing.letter.greeting' })}</h2>
        <p className="landing-page-about-text">
          {intl.formatMessage({ id: 'landing.letter.intro' })}
        </p>
        <p className="landing-page-about-text">
          {intl.formatMessage({ id: 'landing.letter.para1' })}
          <blockquote>
            {intl.formatMessage({ id: 'landing.letter.quote1' })}
          </blockquote>
          {intl.formatMessage({ id: 'landing.letter.para1b' })}
        </p>
        <p className="landing-page-about-text">
          {intl.formatMessage({ id: 'landing.letter.para2' })}
          <blockquote>
            {intl.formatMessage({ id: 'landing.letter.quote2' })}
          </blockquote>
          {intl.formatMessage({ id: 'landing.letter.para2b' })}
        </p>
        <p className="landing-page-about-text">
          {intl.formatMessage({ id: 'landing.letter.para3' })}
        </p>
        <p className="landing-page-about-text">
          {intl.formatMessage({ id: 'landing.letter.para4' })}
        </p>
        <div aria-label="Signed">
          <svg viewBox="0 0 200 60" className="landing-page-signature-svg">
            <path d="
                  M 6 54
                  C 10 50, 13 36, 16 14
                  C 16 22, 15 38, 15 50
                  C 15 42, 13 36, 15 31
                  C 17 27, 23 26, 28 27
                  C 33 28, 37 30, 39 33
                  C 40 40, 39 47, 39 52
                  C 40 46, 43 40, 49 39
                  C 54 38, 57 41, 56 45
                  C 54 48, 49 50, 45 49
                  C 42 48, 40 45, 41 42
                  C 42 38, 45 34, 50 32
                  C 55 30, 58 22, 59 12
                  C 59 22, 58 36, 56 46
                  C 57 40, 60 35, 65 34
                  C 70 34, 72 38, 70 42
                  C 68 46, 64 48, 60 47
                  C 62 41, 65 35, 71 34
                  C 77 34, 80 39, 78 44
                  C 76 49, 72 51, 68 51
                  C 71 44, 75 39, 81 38
                  C 87 38, 89 42, 87 47
                  C 85 51, 80 52, 77 51
                  C 82 51, 89 50, 96 49
                  C 106 48, 116 48, 124 49
                "
                fill="none"
                stroke="#2d2a24"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round" />
          </svg>
        </div>
        <div className="landing-page-about-signature">
          {intl.formatMessage({ id: 'landing.letter.signature' })}
        </div>
        <div className="landing-page-ctas">
          <Link to="/try" className="landing-page-cta">
            {intl.formatMessage({ id: 'landing.tryIt' })}
          </Link>
        </div>
      </section>
      )}

      <PublicFooter locale={locale} />
    </div>
  );
}

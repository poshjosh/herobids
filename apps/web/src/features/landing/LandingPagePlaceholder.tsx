import { useState, useRef, useEffect } from 'react';
import { Link, Navigate } from 'react-router';
import { useSession } from '../../app/providers/SessionProvider.js';
import { LoadingSpinner } from '../../app/layout/RootLayout.js';
import { BrandLogo } from '../../brand/BrandLogo.js';
import { PublicFooter } from '../public-pages/PublicLayout.js';
import { useLocale } from '../../app/i18n/I18nProvider.js';

export function LandingPagePlaceholder() {
  const { user, loading } = useSession();
  const { locale } = useLocale();
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
      <div className="landing-page-row">
        <div className="landing-page-hero">
          <div className="landing-page-card">
            <BrandLogo display="full" variant="dark" size="lg" />
            <p className="landing-page-tagline">
              Affordable AI agents that get the job done
            </p>
            <p className="landing-page-description">
              We offer AI as a service so that you can have your own 
              personal assistant without needing to know about agents, 
              servers or hosting.
            </p>
            <div className="landing-page-ctas">
              <Link to="/login" className="landing-page-cta">
                Sign in
              </Link>
              <Link to="/try" className="landing-page-cta">
                Try it
              </Link>
            </div>
          </div>
        </div>

        <div className="landing-page-proofs">
          <div className="landing-page-proof">
            <p className="landing-page-proof-heading">Our agents cost less</p>
            <p className="landing-page-proof-text">
              We focus our research on saving cost. We believe we are No.&nbsp;1 on
              affordability, without losing effectiveness; and we are increasing
              the gap.
            </p>
            <Link to="/docs/agents/how-agent-costs-are-kept-low" className="landing-page-proof-link">
              See how costs are kept low
            </Link>
          </div>

          <div className="landing-page-proof">
            <p className="landing-page-proof-heading">Get your agent in one click</p>
            <p className="landing-page-proof-text">
              After login. Click one button to create your AI agent, the same
              way you sign one letter to employ a new team member. Thereafter 
              onboard your new AI employee.
            </p>
            <Link to="/try" className="landing-page-proof-link">
              Employ your first AI agent
            </Link>
          </div>
        </div>
      </div>

      <button
        className="landing-page-letter-toggle"
        onClick={() => setLetterOpen((v) => !v)}
        aria-expanded={letterOpen}
      >
        A letter for you
      </button>

      {letterOpen && (
      <section className="landing-page-about" ref={letterRef}>
        <h2 className="landing-page-about-heading">Dear OpenAIdom user,</h2>
        <p className="landing-page-about-text">
          This is what we offer:
        </p>
        <p className="landing-page-about-text">
          Imagine you create your own AI personal assistant, then send it a messge on Telegram: 

          <blockquote>
            I am on a tight budget, so I want you to help me save money by spending wisely
          </blockquote>
          
          Your assistant is an AI agent, and knows that it's reasoning and actions costs money, 
          so it adjusts.
        </p>
        <p className="landing-page-about-text">

          Next you tell your assistant to: 
          
          <blockquote>
            find the best flight deal from Bengaluru to San Francisco between 1st and 3rd of next month.
          </blockquote>

          Your assistant asks a few questions to clarify your preferences, and then it goes to work.
          Not long after you receive an email from your assistant with a link to the best flight deal.
        </p>
        <p className="landing-page-about-text">
          Over time, your assistant gets to know you. It remembers what matters to you, learns your 
          preferences, and becomes more useful.
        </p>
        <p className="landing-page-about-text">
          This is already possible, but at a high cost. We have made it much more affordable.
          Don't just take our word for it, try it.
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
          Helen
        </div>
        <div className="landing-page-ctas">
          <Link to="/try" className="landing-page-cta">
            Try it
          </Link>
        </div>
      </section>
      )}

      <PublicFooter locale={locale} />
    </div>
  );
}

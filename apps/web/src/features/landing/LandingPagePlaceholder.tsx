import { Link, Navigate } from 'react-router';
import { useSession } from '../../app/providers/SessionProvider.js';
import { LoadingSpinner } from '../../app/layout/RootLayout.js';
import { BrandLogo } from '../../brand/BrandLogo.js';

export function LandingPagePlaceholder() {
  const { user, loading } = useSession();

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

      <section className="landing-page-about">
        <h2 className="landing-page-about-heading">Dear OpenAIdom user,</h2>
        <p className="landing-page-about-text">
          Here is what we are working towards:
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
          This is already possible, but at a high cost. We have made it more affordable.
          Don't just take our word for it, try it yourself. Sign in and create your first assistant.
        </p>
        <p className="landing-page-about-text">
          Signed,
          <br/>
          Helen
        </p>
        <div className="landing-page-ctas">
          <Link to="/login" className="landing-page-cta">
            Sign in
          </Link>
          <Link to="/try" className="landing-page-cta">
            Try it
          </Link>
        </div>
      </section>
    </div>
  );
}

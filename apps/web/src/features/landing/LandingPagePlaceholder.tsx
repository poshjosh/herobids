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
    <div className="landing-page">
      <div className="landing-page-image">
        <img
          src="/openaidom-background.avif"
          alt="OpenAIdom — AI agent illustration with speech bubble"
          width={1536}
          height={1024}
          fetchPriority="high"
        />
      </div>
      <div className="landing-page-content">
        <BrandLogo display="full" variant="auto" size="lg" />
        <p className="landing-page-tagline">
          Low cost AI agents that trade, assist, research and more
        </p>
        <p className="landing-page-copy">
          Describe what you want, and an AI agent gets it for you.
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
  );
}

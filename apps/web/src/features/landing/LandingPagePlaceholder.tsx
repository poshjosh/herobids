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
      <div className="landing-page-card">
        <BrandLogo display="full" variant="dark" size="lg" />
        <p className="landing-page-tagline">
          Affordable AI agents that get the job done
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

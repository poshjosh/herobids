import { useNavigate } from 'react-router';
import { PageShell, EmptyState, Button } from '../lib/ui.js';

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <PageShell>
      <EmptyState
        title="Page not found"
        message="The page you're looking for doesn't exist or has been moved."
        action={
          <Button variant="ghost" size="sm" onClick={() => navigate('/agents')}>
            ← Back to AI Agents
          </Button>
        }
      />
    </PageShell>
  );
}

import { PublicLayout } from './PublicLayout.js';

export function PublicNotFound() {
  return (
    <PublicLayout>
      <div style={{ textAlign: 'center', padding: '48px 0' }}>
        <h1 style={{ fontSize: '24px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
          Page not found
        </h1>
        <p style={{ color: 'var(--color-text-secondary)', marginTop: '8px' }}>
          The page you are looking for does not exist.
        </p>
      </div>
    </PublicLayout>
  );
}

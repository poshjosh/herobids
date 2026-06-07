import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { skills as skillsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, SectionLabel, Button } from '../../lib/ui.js';

export function SkillsPage() {
  const query = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list(),
  });
  const navigate = useNavigate();

  const items = query.data?.skills ?? [];
  const builtIn = items.filter((skill) => skill.visibility === 'built-in');
  const userSkills = items.filter((skill) => skill.visibility !== 'built-in');

  return (
    <PageShell>
      <PageHeader
        title="Skills"
        subtitle="Capability bundles that tell agents what they can do"
        action={<Button variant="primary" onClick={() => navigate('/agents?create=1')}>Create agent</Button>}
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No skills yet"
          message="Skills will appear here once built-in or user-authored capability bundles are available."
        />
      )}

      {builtIn.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
          <SectionLabel>Built-in skills</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
            {builtIn.map((skill) => <SkillCard key={skill.id} skill={skill} />)}
          </div>
        </section>
      )}

      {userSkills.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <SectionLabel>Your skills</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
            {userSkills.map((skill) => <SkillCard key={skill.id} skill={skill} />)}
          </div>
        </section>
      )}
    </PageShell>
  );
}

function SkillCard({ skill }: { skill: { name: string; description: string; instructions: string; requiredTools: string[]; contextRequirements: string[]; requiredGuardrails: string[]; visibility: string; tags: string[] } }) {
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '15px', fontWeight: '600', color: 'var(--color-text-primary)' }}>{skill.name}</div>
          <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)' }}>
            {skill.visibility}
          </span>
        </div>
        <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>{skill.description}</div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {skill.tags.map((tag) => (
          <span key={tag} style={pillStyle}>{tag}</span>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' }}>
        <MetaList label="Tools" items={skill.requiredTools} />
        <MetaList label="Context" items={skill.contextRequirements} />
        <MetaList label="Guardrails" items={skill.requiredGuardrails} />
        <MetaList label="Instructions" items={[skill.instructions.slice(0, 120) + (skill.instructions.length > 120 ? '…' : '')]} />
      </div>
    </Card>
  );
}

function MetaList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)', marginBottom: '6px' }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {items.length > 0 ? items.map((item) => <span key={item} style={pillStyle}>{item}</span>) : <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>None</span>}
      </div>
    </div>
  );
}

const pillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '3px 8px',
  borderRadius: '20px',
  background: 'var(--color-surface-2)',
  color: 'var(--color-text-secondary)',
  fontSize: '12px',
};
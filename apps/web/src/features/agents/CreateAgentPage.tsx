import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { skills as skillsApi } from '../../lib/api-client.js';
import { PageShell } from '../../lib/ui.js';
import { listSelectableSkills } from './agent-display.js';
import { CreateAgentFlow } from './CreateAgentFlow.js';

/** Dedicated page for creating a new AI agent. */
export function CreateAgentPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list({ scope: 'selectable' }),
  });
  const selectableSkills = listSelectableSkills(skillsQuery.data?.skills ?? []);

  const handleCreated = (id: string) => {
    void qc.invalidateQueries({ queryKey: ['agents'] });
    navigate(`/agents/${id}`);
  };

  return (
    <PageShell>
      <CreateAgentFlow
        skills={selectableSkills}
        skillsLoading={skillsQuery.isLoading}
        skillsError={skillsQuery.error instanceof Error ? skillsQuery.error.message : null}
        onClose={() => navigate('/agents')}
        onCreated={handleCreated}
      />
    </PageShell>
  );
}

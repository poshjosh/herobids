import { useIntl } from 'react-intl';
import { listSelectableSkills } from './agent-display.js';
import type { Skill } from '../../lib/api-client.js';

interface SkillPickerProps {
  skills: Skill[];
  selectedSkillIds: string[];
  onChange: (skillIds: string[]) => void;
  loading?: boolean;
  errorMessage?: string | null;
}

export function SkillPicker({ skills, selectedSkillIds, onChange, loading = false, errorMessage = null }: SkillPickerProps) {
  const intl = useIntl();
  const selectableSkills = listSelectableSkills(skills);
  const selected = new Set(selectedSkillIds);

  if (loading) {
    return <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.skillPicker.loading' })}</div>;
  }

  if (errorMessage) {
    return <div style={{ fontSize: '13px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>{errorMessage}</div>;
  }

  if (selectableSkills.length === 0) {
    return <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.skillPicker.empty' })}</div>;
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        maxHeight: selectableSkills.length > 4 ? '280px' : undefined,
        overflowY: selectableSkills.length > 4 ? 'auto' : undefined,
        paddingRight: selectableSkills.length > 4 ? '4px' : undefined,
      }}
    >
      {selectableSkills.map((skill) => {
        const isSelected = selected.has(skill.id);

        return (
          <label
            key={skill.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              padding: '10px 12px',
              border: `1px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
              borderRadius: '8px',
              cursor: 'pointer',
              background: isSelected ? 'var(--color-accent-subtle, rgba(99,102,241,0.08))' : 'transparent',
            }}
          >
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => {
                onChange(isSelected ? selectedSkillIds.filter((skillId) => skillId !== skill.id) : [...selectedSkillIds, skill.id]);
              }}
              style={{ marginTop: '3px', flexShrink: 0 }}
            />
            <div>
              <div style={{ fontWeight: '500', fontSize: '14px' }}>{skill.name}</div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px', lineHeight: '1.45' }}>
                {skill.description.length > 50 ? `${skill.description.slice(0, 50)}…` : skill.description}
              </div>
            </div>
          </label>
        );
      })}
    </div>
  );
}
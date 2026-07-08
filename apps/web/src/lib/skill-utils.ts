import type { Skill } from './api-client.js';

/** Client-side skill search: case-insensitive substring match on name and description. */
export function filterSkillsBySearch(skills: Skill[], term: string): Skill[] {
  const t = term.trim().toLowerCase();
  if (!t) return skills;
  return skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(t) ||
      skill.description.toLowerCase().includes(t),
  );
}

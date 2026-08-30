export interface ExternalSkillSummary {
  /** Canonical ref: owner/repo/skillId */
  ref: string;
  /** Skill ID from external registry */
  skillId: string;
  name: string;
  description: string;
  owner: string;
  repo: string;
  /** Install count from the external registry */
  installs: number;
  tags?: string[];
}

export interface ExternalSkillPage {
  results: ExternalSkillSummary[];
  /** Total matching skills in the external catalog. */
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface ExternalSkillStats {
  totalSkills: number;
  totalSources: number;
  totalOwners: number;
}

export interface ExternalSkillProvider {
  /** Search external skills by keyword. Paginated. */
  search(query: string, opts: { page: number; pageSize: number }): Promise<ExternalSkillPage>;

  /** Browse external skills (no query — returns popular/default listing). Paginated. */
  browse(opts: { page: number; pageSize: number }): Promise<ExternalSkillPage>;

  /**
   * Get registry statistics (total skills, sources, owners).
   * Used for the headline count. Result should be cached by the implementation.
   */
  getStats(): Promise<ExternalSkillStats | null>;
}

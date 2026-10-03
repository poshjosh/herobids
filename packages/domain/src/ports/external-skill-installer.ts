/**
 * Outcome of one external-skill install. Deliberately the same shape as the
 * skills-CLI subprocess result that `add_skills` already reports verbatim
 * (Phase 3 P3-4), so the tool output is unchanged whichever installer runs.
 */
export type ExternalSkillInstallResult = { ok: true; output: string } | { ok: false; error: string };

/**
 * Installs an external skill into an agent workspace at
 * `<workspaceRoot>/.agents/skills/<name>/`, where `<name>` is the sanitized
 * SKILL.md frontmatter `name`. That name must equal the ref's skill segment,
 * because the post-install reader derives the directory from the ref.
 * Implementations report failures as `{ ok: false }` and never reject.
 */
export interface ExternalSkillInstaller {
  /** `ref` is the normalized skills-CLI form, e.g. `owner/repo@skill`. */
  install(ref: string, workspaceRoot: string): Promise<ExternalSkillInstallResult>;
}

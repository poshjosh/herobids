# Bug Report: staging agents run an agent image 78 commits behind the worker, and nothing says so

- **Status:** MITIGATED (the pin is now flagged on every deploy). The staging and production pins are NOT moved yet; that needs the probe in `deploy.md`, "Agent image pin".
- **Severity:** High
- **Date:** 2026-11-17
- **Environment:** staging (production carries the same pin and the same gap), agent `job-searcher` (`8365d836-7e09-470c-bbf0-06f69f3848b7`)
- **Related:** `docs/bug-reports/2026/11/14/002-durable-tool-results-deleted-by-stale-truncation.md`, `docs/features/2026/11/14/003-agent-run-status-hint/plan.md`, `docs/features/2026/11/12/001-hetzner-scale-path/sandbox-shell-access.md` (S2/S5)

## Symptom

The `job-searcher` agent (skill `job-search`, 2-hour search interval) had run for about 24 hours and held 10 job records, far fewer than expected. In that window it also:

- never created the skill's state files (`search/run-state.json`, `search/search-ledger.json`, `schedules/schedule-state.json`, `reports/report-state.json`: `file not found`);
- failed `edit_file` and `read_file_lines` with `unknown tool`, after which the `edit_file` circuit opened.

## Investigation (read-only, staging)

- The schedule was healthy: 12 scheduled ticks, one every 2 hours. Each ran 1 to 3 minutes against a 30-minute skill budget.
- Staging `infra/hetzner/.env.staging` and the worker env pin `NOMAD_AGENT_IMAGE=ghcr.io/poshjosh/herobids-agent:sha-b317176e...` (commit date 2026-11-12). The worker and API run v0.10.1 (`6342b46f`, 2026-11-16): 78 commits ahead. Production has the same pin.
- The pinned image predates `7c569548` (durable tool results survive stale truncation), the agent file tools (`4fcded47` onward) and the run-status hint, which `config/staging.yaml` enables but the old image ignores.
- The agent node's local `:latest` and the pin are the same digest (`d04aeb2d0198`), so the pin was the only thing keeping agents on that build.

## Root Cause

The pin was added deliberately for the sandbox rollout (sandbox plan S2/S5: pin, probe, then move). It is set by hand in the gitignored `.env.<env>`. `push.sh` and `deploy.sh` update the worker and API but never touch it, and nothing compared the pin with the deployed commit, so it went stale with no signal. The sandbox plan's "re-pin rule" only says to re-probe when the tag changes; it does not say the tag must be revisited.

## Fix

Keep the pin and make a stale one impossible to miss. New `infra/hetzner/scripts/check-agent-image-pin.sh` prints a bold banner (no colour) when `NOMAD_AGENT_IMAGE` is unset, is not a `sha-<commit>` tag, points at a commit the checkout lacks, is not an ancestor of the deployed commit, or lags it. For a lagging pin it shows the age, the number of commits behind, and the sandbox/entrypoint files that changed since (the files the probe covers). It only warns (exit 0) and is skipped when `RUNTIME_BACKEND` is not `nomad`.

- `push.sh` runs it after the deploy; `maintenance-restart.sh` runs it before it reports completion; `deploy.sh` repeats it as its last output.
- The banner carries the fix: `infra/hetzner/scripts/release-agent-image.sh --env <env>`. That script releases the commit deployed on the server: it checks CI published the image, probes it on a live agent node (`probe-agent-image.sh`, sandbox rows K0 to K7, which were a manual checklist in sandbox plan S3), sets `NOMAD_AGENT_IMAGE` in `infra/hetzner/.env.<env>`, uploads it, recreates the worker (`up -d --force-recreate --no-deps worker`, because `restart` does not re-read `.env`), confirms the worker reports the new value, and offers to relaunch running agents. `--dry-run` stops after the probe. A failed probe leaves the pin unchanged.
- Staging and production use the same scripts and the same check.
- The check is a single `git` comparison on the control plane. It does not list agents or Nomad jobs, so it costs the same with 10 or 10,000 agents.

Docs: `infra/hetzner/docs/deploy.md` ("Agent image pin"), `.env.environment.example`, `docs/runbooks/useful-commands.md`, `infra/hetzner/docs/auto-scaling/lessons-learnt.md` (lesson 22), `CHANGELOG.md`.

## Files Changed

- `infra/hetzner/scripts/check-agent-image-pin.sh` (new)
- `infra/hetzner/scripts/release-agent-image.sh` (new): the command the banner prints
- `infra/hetzner/scripts/probe-agent-image.sh` (new): sandbox rows K0 to K7, runs on an agent node
- `infra/hetzner/scripts/push.sh`, `infra/hetzner/scripts/maintenance-restart.sh`, `infra/hetzner/deploy.sh`
- `infra/hetzner/.env.environment.example`, `infra/hetzner/docs/deploy.md`, `infra/hetzner/docs/auto-scaling/lessons-learnt.md`, `docs/runbooks/useful-commands.md`, `CHANGELOG.md`

## Verification

**Done:**

- `bash -n` on all scripts; `infra/hetzner/scripts/tests/run-all.sh` passes.
- Ran `check-agent-image-pin.sh` against a throwaway git repo for each state: non-Nomad backend (skipped), unset, not a sha tag, up to date (OK line), stale (banner, commits behind, changed sandbox file listed), commit missing from the checkout, value read from `.env`, and exit code 0. The banner shows the release command for the environment.
- `probe-agent-image.sh` on the real staging agent node (`herobids-staging-agent-1`, 10.0.0.3), through the control plane: PASS on K0 to K7 for the old pin (`sha-b317176e`). It FAILs correctly for a tag that does not exist (K0) and for a wrong control-plane IP (K5).
- `release-agent-image.sh --env staging --dry-run` against the real staging server: deployed commit `6342b46f` (v0.10.1), image present in GHCR, probe K0 to K7 all PASS on the agent node. Also checked: a malformed `--sha`, an unknown flag, and a `--sha` that is not in GHCR all stop with a clear error and no change. The `.env` rewrite (replace, add when only a commented line exists, collapse duplicates) was checked on a temp file.

**Not done:**

- First real release on staging (run by the owner, commit `4a71f8e9`): the probe passed, the env file was edited and uploaded, and the worker was recreated and reports the new pin. The script then stopped with `worker reports NOMAD_AGENT_IMAGE=''`. Cause: the check ran `ssh host VAR=x 'cd /opt/herobids && docker compose -f ... -f "${VAR}" exec ...'`; a prefix assignment applies only to the first command (`cd`), so the overlay was empty, compose failed, and `2>/dev/null` hid the error. The release itself was fine (confirmed read-only: server `.env` and the worker container both hold the new pin). Fixed: the overlay name is written into the command, the compose error is shown when the check fails, and re-running the script when the pin is already set now skips steps 2 to 4, confirms the worker, and continues to step 5 instead of exiting. Step 5 (relaunch) had not run yet at that point.
- The banner first printed white on a red background, then red text. Red reads as an error and nothing was wrong, so the banner and `release-agent-image.sh` now use bold only, no colour.
- Not run through `push.sh` / `deploy.sh` on a real server; the next deploy is the first run.
- No automated test was added for these scripts.
- The pins on staging and production are still stale until `release-agent-image.sh` is run for each. Agents already running stay on their old image until relaunched.
- `release-agent-image.sh` relaunches through `maintenance-restart.sh`, which is serial. Fine for tens of agents; at thousands it needs a rolling controller.
- Running the release from GitHub Actions after every `main` build is deferred.
- `shellcheck` is not installed here, so the scripts were not linted.

## Outstanding Issues

These are separate from the stale pin and are not fixed here:

- 6 of 11 scheduled `job-searcher` ticks (and the 07:38 reply tick) ended with `provider.invalid_tool_args`: the model sent malformed tool-call JSON. `callLlmWithRetry` replays the identical request twice, then drops the tick. The failing call was not identified.
- The agent has no `make_http_request` grant (`Unknown capability`) and only generic web search (Tavily, at most 10 results per call), so it cannot reach job-board or ATS APIs.
- The skill's early stop and repeated-query behaviour (about 5% of the run budget, one query reissued about 10 times) is the under-running problem in the run-status-hint plan.

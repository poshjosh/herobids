# Infra Docs Index

Which doc do you actually want? Start here.

| I want to... | Use | Notes |
|---|---|---|
| Understand the architecture (environments, directory layout, Nomad topology, ACL model, autoscale mechanics) | `../README.md` | Reference, not a how-to. Read when you need to understand *why*, not *what to run*. |
| Provision a **brand-new** server for the first time (new deploy key, new DNS) | `setup.md` | Phase-by-phase: prereqs → env files → SSH key → provision → DNS → verify → Nomad ACL bootstrap. |
| Enable Nomad/autoscale on a server that **already exists without it** | `auto-scaling/setup-auto-scaling.md` | Different from `setup.md` — this is the retrofit path (`prevent_destroy=false`, replace-in-place), not a from-scratch provision. |
| Ship routine code changes to an already-healthy server | `deploy.md` | Steady-state loop: upload env → deploy → seed (if needed) → smoke test. |
| Destroy and rebuild an environment, or recover from a broken Nomad cluster/stale ACL token/crash loop | `runbooks/reprovision-runbook.md` | The one doc with the full ordered teardown→provision→verify→deploy→start→smoke-test sequence. Covers both staging and production. |
| Operate a running Nomad cluster day-to-day (check status, scale, troubleshoot drain timeouts/403s/backend errors) | `auto-scaling/useful-commands.md` | Command reference, not a setup guide. |
| Know what's genuinely different about production (not just different values) | `runbooks/production-notes.md` | Private IPs, SSH keys, scaling floor, confirmation prompts, the Traderton-production dependency, stale-DB reprovisioning. **Read before running any staging-oriented doc against production.** |
| Check if a problem you're hitting is a known, already-diagnosed issue | `auto-scaling/lessons-learnt.md` | Numbered, append-only bug/pitfall log. Check here before deep-diving a new investigation. |
| See the dated evidence record for the herobids↔Traderton Phase 1 integration proof | `runbooks/phase1-operational-readiness.md` | Historical point-in-time record, not a living how-to. |

## How the "how-to" docs relate to each other

```
setup.md ───────────────┐
  (brand-new server,     │
   Nomad on from the     ├──► Phase 6 (ACL bootstrap) and Phase 7 (teardown/
   start)                │    rebuild) both hand off to reprovision-runbook.md
                         │    rather than duplicating it.
auto-scaling/            │
setup-auto-scaling.md ───┤    (retrofit: enable Nomad on an existing
  (Nomad didn't exist     │    non-Nomad server)
   yet, turning it on)    │
                         │
deploy.md ───────────────┘    (steady-state: server exists, Nomad or not,
  (routine deploy)             just ship code)
                               If deploy.sh fails in a way routine retry
                               doesn't fix → escalate to reprovision-runbook.md.

runbooks/reprovision-runbook.md
  The one place with the full ordered sequence. setup.md's Phase 7 and the
  old staging-only runbook both used to duplicate this — don't recreate that
  duplication if you add new teardown/rebuild content; add it here instead.
```

## Rule of thumb for contributing to these docs

- **Day-2 operational knowledge** (a command, a troubleshooting step, a gotcha)
  belongs in `runbooks/reprovision-runbook.md` (if it's part of the ordered
  sequence) or `auto-scaling/useful-commands.md` (if it's an ad hoc
  command) or `auto-scaling/lessons-learnt.md` (if it's a bug writeup).
- **First-time setup knowledge** belongs in `setup.md` or
  `auto-scaling/setup-auto-scaling.md`, whichever scenario it's for.
- **Production-only deltas** belong in `runbooks/production-notes.md`, not
  scattered as inline caveats across the other docs. If you catch yourself
  writing "in production, X is different" inside `setup.md` or the runbook,
  move it to `production-notes.md` and leave a one-line cross-reference
  instead.
- Before adding a new "how to do X" doc, check this index first — there is
  deliberately **one** canonical doc per scenario. If two docs seem to cover
  the same ground, that's a bug in the docs; fix the overlap rather than
  letting both drift.

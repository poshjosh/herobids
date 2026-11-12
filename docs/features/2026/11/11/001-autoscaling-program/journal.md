# Journal

Append-only. One short entry per session, newest at the bottom. Read the last five entries when you resume. Format: [conventions.md](./conventions.md) section 7.

## 2026-11-11 17:00  Kiro
Worked on: program setup; M1 and F1.1 planning
Done: created this program folder (entry point, milestones, conventions, inbox, templates); M1 README; F1.1 plan; autoscaler coupling analysis in `m1-shared-core/reference/`. Read-only checks: staging autoscaler log; infra suite run locally (passes)
Decided: C-12 (no hibernation) and C-13 (stop over-limit agents) recorded earlier today; execution-approval list confirmed by the owner (every staging change needs approval, read-only does not). No new decisions
Learned: staging autoscale-out is refused every minute with `ownership_mismatch`; the caps pool names (`-agent-caps-N`) do not match the guard's shape; start times on staging are median 6.4 s, p90 20.0 s, worst 333.5 s (A-22); the community Nomad Autoscaler Hetzner plugin provisions servers directly (outside Terraform); the control plane has no Node runtime
Next action: F1.1 task A2 (capture golden outputs), then A3 (reproduce the block locally)
Blocked on: nothing. Inbox I-001 (confirm this structure) and I-002 (two owner facts) are open and do not block F1.1 phases A to C

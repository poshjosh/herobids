# eval-readonly — Nomad ACL policy for evaluators and log readers.
#
# Allows: listing and reading jobs and allocations, reading task logs and
#         allocation files (`nomad alloc logs`, `nomad alloc fs`), reading nodes,
#         and `nomad alloc exec` in the agent namespace, so an evaluator can
#         `cat`/`ls` workspace files and read container state.
# Denies: submitting/stopping jobs, ACL changes, node drain.
#
# NOTE: `alloc-exec` can run any command in an agent container, so this token
# is read-only by convention, not by enforcement. Evaluators must run only
# read commands (cat, ls, printenv of single named variables). The
# evaluate-* skills state this as a constraint.
#
# Applied by infra/hetzner/scripts/setup-nomad-readonly.sh.

namespace "herobids-agents" {
  capabilities = ["list-jobs", "read-job", "read-logs", "read-fs", "alloc-exec"]
}

namespace "default" {
  capabilities = ["list-jobs", "read-job"]
}

node {
  policy = "read"
}

#!/usr/bin/env bash
# capacity-controller.sh — Decision, plan-allowlist and durable-state helpers for the
# demand-aware scale-out controller (plan 5.6 and 5.7).
#
# Source after scale-common.sh and capacity-demand.sh. The decision and allowlist
# functions read JSON on stdin and touch no network, Terraform or Hetzner state. The
# state helpers write only under NOMAD_AUTOSCALE_STATE_DIR and must be called in mutate
# mode only. Dry-run never calls them.
#
# Functions:
#   controller_decide
#       stdin:  {"floor", "cap", "increment_max", "pool_count", "live_managed", "active",
#                "viable_inflight", "unavailable", "template": {"memory_mb", "cpu_mhz"},
#                "cooldown_active", "failure_backoff_active", "headroom_pressure",
#                "classification_usable",
#                "bins":  [{"id", "kind": "actual"|"viable", "free_memory_mb", "free_cpu_mhz"}],
#                "items": [{"key", "class": "backlog"|"headroom", "mature", "memory_mb",
#                           "cpu_mhz", "count"}]}
#       prints: {"action": "add"|"noop", "nodes_to_add", "target_count", "uncovered_nodes",
#                "floor_deficit", "remaining_headroom", "fit", "unplaceable", "reasons"}
#       Exit 1 on invalid or ambiguous input (fail closed). Floor deficit and backlog/headroom
#       are simulated in one fit, so a node is never added twice for the same demand. Viable
#       in-flight bins are passed in bins and so reduce the need for new nodes.
#   controller_ready_crosscheck CHECK_READY INVENTORY_READY INVENTORY_MANAGED
#       prints ready, capacity_blocked (no managed servers), or dead_pool (managed servers
#       exist but none is ready). Exit 1 if check-nomad-capacity and the inventory disagree.
#   controller_plan_allowlist CURRENT_COUNT EXPECTED_ADDS CAP
#       stdin: `terraform show -json SAVED_PLAN`. Exit 0 only for a create-only plan that adds
#       exactly hcloud_server.agent[i] and hcloud_server_network.agent[i] for
#       i in [CURRENT, CURRENT+EXPECTED), ends at or under CAP, and has no drift. Nothing from
#       the plan is printed.
#   controller_failure_backoff_active NOW / controller_record_failure NOW
#   controller_streak_read / controller_streak_observe STATUS / controller_streak_mature
#       Durable state for failure backoff and the consecutive-observation maturity gate.

CONTROLLER_FAILURE_FILE="${CONTROLLER_FAILURE_FILE:-${NOMAD_AUTOSCALE_STATE_DIR}/last-failure}"
CONTROLLER_STREAK_FILE="${CONTROLLER_STREAK_FILE:-${NOMAD_AUTOSCALE_STATE_DIR}/capacity-blocked-streak}"

# Shared jq helpers. Each check returns an error message, or nothing when the value is fine.
_CONTROLLER_UINT_JQ='
def uint($lo; $hi): type == "number" and . >= $lo and . <= $hi and . == floor;
def check($ok; $msg): if $ok then empty else $msg end;
'

_CONTROLLER_PREP_JQ="${_CONTROLLER_UINT_JQ}"'
. as $in
| if ($in | type) != "object" then error("controller input must be an object") else . end
| [
    check(($in.floor | uint(0; 100000)); "floor"),
    check(($in.cap | uint(0; 100000)); "cap"),
    check(($in.increment_max | uint(1; 2)); "increment_max must be 1 or 2"),
    check(($in.pool_count | uint(0; 100000)); "pool_count"),
    check(($in.live_managed | uint(0; 100000)); "live_managed"),
    check(($in.active | uint(0; 100000)); "active"),
    check(($in.viable_inflight | uint(0; 100000)); "viable_inflight"),
    check(($in.unavailable | uint(0; 100000)); "unavailable"),
    check(($in.template.memory_mb | uint(1; 100000)); "template.memory_mb"),
    check(($in.template.cpu_mhz | uint(1; 100000)); "template.cpu_mhz"),
    check((($in.cooldown_active | type) == "boolean"); "cooldown_active"),
    check((($in.failure_backoff_active | type) == "boolean"); "failure_backoff_active"),
    check((($in.headroom_pressure | type) == "boolean"); "headroom_pressure"),
    check((($in.classification_usable | type) == "boolean"); "classification_usable"),
    check((($in.bins // []) | type) == "array"; "bins must be an array"),
    check(([($in.bins // [])[] | (.kind == "actual" or .kind == "viable")
            and (.id | type) == "string"
            and (.free_memory_mb | uint(0; 999999999))
            and (.free_cpu_mhz | uint(0; 999999999))] | all); "bin has an invalid kind or figure"),
    check((($in.items // []) | type) == "array"; "items must be an array"),
    check(([($in.items // [])[] | (.class == "backlog" or .class == "headroom")
            and (.mature | type) == "boolean"
            and (.key | type) == "string"
            and (.memory_mb | uint(1; 100000))
            and (.cpu_mhz | uint(1; 100000))
            and (.count | uint(0; 100000))] | all); "item has an invalid class or figure")
  ] as $errors
| if ($errors | length) > 0 then error("invalid controller input: " + ($errors | join(", "))) else . end
| ($in.active + $in.viable_inflight) as $sized
| ([0, ($in.floor - $sized)] | max) as $floor_deficit
| ($in.classification_usable and $sized > 0 and $in.headroom_pressure) as $headroom_ok
| [ ($in.items // [])[]
    | select(($in.classification_usable and .class == "backlog" and .mature)
             or ($headroom_ok and .class == "headroom"))
    | { key, memory_mb, cpu_mhz, count, class } ] as $items
| [ range(0; $floor_deficit) | { id: ("floor-" + tostring), kind: "viable",
      free_memory_mb: $in.template.memory_mb, free_cpu_mhz: $in.template.cpu_mhz } ] as $floor_bins
| {
    meta: {
      floor: $in.floor, cap: $in.cap, increment_max: $in.increment_max,
      pool_count: $in.pool_count, live_managed: $in.live_managed, active: $in.active,
      viable_inflight: $in.viable_inflight, unavailable: $in.unavailable,
      cooldown_active: $in.cooldown_active, failure_backoff_active: $in.failure_backoff_active,
      classification_usable: $in.classification_usable, headroom_pressure: $in.headroom_pressure,
      floor_deficit: $floor_deficit,
      backlog_items: ([$items[] | select(.class == "backlog")] | length),
      headroom_items: ([$items[] | select(.class == "headroom")] | length),
      dropped_immature_backlog: ([($in.items // [])[] | select(.class == "backlog" and (.mature | not))] | length),
      dropped_headroom: (([($in.items // [])[] | select(.class == "headroom")] | length)
                        - ([$items[] | select(.class == "headroom")] | length))
    },
    template_memory_mb: $in.template.memory_mb,
    template_cpu_mhz: $in.template.cpu_mhz,
    fit_input: { bins: (($in.bins // []) + $floor_bins), items: [$items[] | { key, memory_mb, cpu_mhz, count }] }
  }
'

_CONTROLLER_DECIDE_JQ='
. as $prep
| $prep.meta as $m
| ($f.new_nodes_needed) as $new_nodes
| ($m.floor_deficit + $new_nodes) as $uncovered
| ([0, ($m.cap - $m.live_managed)] | max) as $remaining
| ($m.cooldown_active or $m.failure_backoff_active) as $blocked
| (if $blocked then 0 else ([$uncovered, $m.increment_max, $remaining] | min) end) as $add
| ([
    (if $m.floor_deficit > 0 then "floor_deficit" else empty end),
    (if $m.floor_deficit > 0 and $m.unavailable > 0 then "recovery" else empty end),
    (if $m.backlog_items > 0 then "backlog" else empty end),
    (if $m.headroom_items > 0 then "headroom" else empty end),
    (if $m.dropped_immature_backlog > 0 then "backlog_not_mature" else empty end),
    (if ($m.classification_usable | not) then "classification_unusable" else empty end),
    (if $uncovered == 0 then "no_demand" else empty end),
    (if $m.cooldown_active then "cooldown_active" else empty end),
    (if $m.failure_backoff_active then "failure_backoff_active" else empty end),
    (if ($uncovered > $remaining and ($blocked | not)) then "cap_clamped" else empty end),
    (if ($uncovered > $m.increment_max and ($blocked | not) and $m.increment_max <= $remaining) then "batch_clamped" else empty end),
    (if ($f.unplaceable | length) > 0 then "unplaceable_items" else empty end)
  ]) as $reasons
| {
    mode: "demand",
    action: (if $add > 0 then "add" else "noop" end),
    nodes_to_add: $add,
    target_count: ($m.pool_count + $add),
    uncovered_nodes: $uncovered,
    floor_deficit: $m.floor_deficit,
    remaining_headroom: $remaining,
    fit: { placed_existing: $f.placed_existing, placed_on_new_nodes: $f.placed_on_new_nodes,
           new_nodes_needed: $new_nodes },
    unplaceable: $f.unplaceable,
    reasons: $reasons
  }
'

# controller_decide — see header. Reads the input JSON on stdin.
controller_decide() {
  local prep fit tmem tcpu
  prep="$(jq -c "${_CONTROLLER_PREP_JQ}")" || return 1
  tmem="$(jq -r '.template_memory_mb' <<< "${prep}")" || return 1
  tcpu="$(jq -r '.template_cpu_mhz' <<< "${prep}")" || return 1
  fit="$(jq -c '.fit_input' <<< "${prep}" | capacity_plan_fit "${tmem}" "${tcpu}")" || return 1
  jq -c --argjson f "${fit}" "${_CONTROLLER_DECIDE_JQ}" <<< "${prep}"
}


# controller_ready_crosscheck CHECK_READY INVENTORY_READY INVENTORY_MANAGED
#   A zero ready count from check-nomad-capacity only means capacity_blocked when the
#   inventory agrees. Disagreement is ambiguous and fails closed.
controller_ready_crosscheck() {
  require_uint CHECK_READY "$1" 0 100000
  require_uint INVENTORY_READY "$2" 0 100000
  require_uint INVENTORY_MANAGED "$3" 0 100000
  local check_ready="$1" inv_ready="$2" inv_managed="$3"
  if (( (check_ready == 0) != (inv_ready == 0) )); then
    echo "ambiguous: check-nomad-capacity ready=${check_ready} but inventory ready=${inv_ready}" >&2
    return 1
  fi
  if (( check_ready > 0 )); then
    echo "ready"
  elif (( inv_managed > 0 )); then
    echo "dead_pool"
  else
    echo "capacity_blocked"
  fi
}

# Allowlist for the saved plan (plan 5.7). Only create actions on the agent server and its
# network attachment, for the exact indices the decision expects, are accepted.
#
# H1: every accepted create must also carry a known change.after with the expected shape:
#   hcloud_server:          server_type, location, labels.environment and name
#                           (<server_name>-agent-<index+1>, as main.tf names it) must equal the
#                           expected Terraform inputs.
#   hcloud_server_network:  network_id must equal the environment network's id, read from the
#                           plan's prior_state (hcloud_network.private[0], whose name and
#                           environment label must match this environment).
# Fail-closed rules: change.after must be an object; no checked path (or any parent of it) may
# be after_unknown; an empty expected input or a missing or foreign network fails the plan.
# Documented exception (the only unknown the allowlist accepts): hcloud_server_network.server_id
# is unknown at plan time when its server is created in the same plan. It is accepted only as
# after_unknown true with a null after. The matching hcloud_server create at the same index is
# enforced by the $servers/$networks index checks above. A known server_id is rejected.
# Unverified (H4): the prior_state and after shapes come from a synthetic fixture, not from a real
# `terraform show -json`. The checks must be re-verified against a captured plan in P8/P9.
_CONTROLLER_ALLOWLIST_JQ='
def unknown_any($p): (.change.after_unknown // {}) as $u
  | [ range(0; ($p | length) + 1) as $i | ($u | try getpath($p[0:$i]) catch null) ]
  | any(. == true);
def after_at($p): (.change.after | try getpath($p) catch null);
def server_ok($sn; $st; $loc; $env):
  ((.change.after | type) == "object")
  and ((unknown_any(["name"])) | not) and (after_at(["name"]) == ($sn + "-agent-" + ((.index + 1) | tostring)))
  and ((unknown_any(["server_type"])) | not) and (after_at(["server_type"]) == $st)
  and ((unknown_any(["location"])) | not) and (after_at(["location"]) == $loc)
  and ((unknown_any(["labels", "environment"])) | not) and (after_at(["labels", "environment"]) == $env);
def network_ok($nid):
  ((.change.after | type) == "object")
  and ((unknown_any(["network_id"])) | not) and ((after_at(["network_id"]) | tostring) == $nid)
  and (unknown_any(["server_id"]) == true) and (after_at(["server_id"]) == null);
(.resource_drift // []) as $drift
| if ($drift | length) > 0 then error("saved plan reports drift; refusing") else . end
| [ (.resource_changes // [])[]
    | select(.change.actions != ["no-op"] and .change.actions != ["read"]) ] as $changed
| if ($changed | length) == 0 then error("saved plan has no resource changes") else . end
| if ([ $changed[]
        | .change.actions == ["create"]
          and .mode == "managed"
          and (((.type == "hcloud_server") and (.name == "agent")
                and .address == "hcloud_server.agent[\(.index)]")
            or ((.type == "hcloud_server_network") and (.name == "agent")
                and .address == "hcloud_server_network.agent[\(.index)]"))
          and (.index | type) == "number" ] | all)
   then . else error("saved plan has an update, delete, replace or a create on a protected or unrelated resource") end
| ([ $changed[] | select(.type == "hcloud_server") | .index ] | sort) as $servers
| ([ $changed[] | select(.type == "hcloud_server_network") | .index ] | sort) as $networks
| ([range($cur; $cur + $exp)]) as $want
| if $exp < 1 then error("no additions expected") else . end
| if ($cur + $exp) > $cap then error("prospective node count exceeds the cap") else . end
| if $servers != $want then error("server creates do not match the expected indices") else . end
| if $networks != $want then error("network creates do not match the expected indices") else . end
| if (($sn | length) == 0) or (($st | length) == 0) or (($loc | length) == 0) or (($env | length) == 0)
   then error("an expected Terraform input is empty; refusing") else . end
| ([ (.prior_state.values.root_module.resources // [])[] | select(.address == "hcloud_network.private[0]") ]) as $nets
| if ($nets | length) != 1
   then error("hcloud_network.private[0] is not in the prior state of this plan; the attachment cannot be verified") else . end
| ($nets[0].values // {}) as $nv
| if (($nv.name // null) != ($sn + "-net")) or (($nv.labels.environment // null) != $env)
   then error("the prior network is not the network of this environment; refusing") else . end
| ((($nv.id // null) | tostring)) as $nid
| if ($nid == "null") or ($nid == "") then error("the prior network has no id; refusing") else . end
| if ([ $changed[] | select(.type == "hcloud_server") | server_ok($sn; $st; $loc; $env) ] | all)
   then . else error("a server create does not match the expected type, location, environment label or name") end
| if ([ $changed[] | select(.type == "hcloud_server_network") | network_ok($nid) ] | all)
   then . else error("a network attachment create does not match the expected network or has an unknown or known server link") end
| "allowlist_ok"
'

# controller_tf_input NAME VAR_FILE — prints the value Terraform will use for NAME: the quoted
# literal in VAR_FILE when the key is set there (Terraform -var-file wins), else TF_VAR_<name>.
# Returns 1 when neither is set, the file sets the key twice, or the literal is not a simple
# token. A missing input is never guessed from a Terraform default (fail closed).
controller_tf_input() {
  local name="$1" file="$2" count value env_name
  if [[ -f "${file}" ]]; then
    count="$(grep -cE "^${name}[[:space:]]*=" "${file}" || true)"
    if (( count > 1 )); then
      return 1
    fi
    if (( count == 1 )); then
      value="$(grep -E "^${name}[[:space:]]*=" "${file}" | sed -E 's/^[^=]*=[[:space:]]*"([^"]*)".*$/\1/')"
      if [[ "${value}" =~ ^[A-Za-z0-9._-]+$ ]]; then
        printf '%s\n' "${value}"
        return 0
      fi
      return 1
    fi
  fi
  env_name="TF_VAR_${name}"
  if [[ -n "${!env_name:-}" ]]; then
    printf '%s\n' "${!env_name}"
    return 0
  fi
  return 1
}

# controller_plan_allowlist CURRENT_COUNT EXPECTED_ADDS CAP SERVER_NAME SERVER_TYPE LOCATION ENVIRONMENT
# The four expected values are the Terraform inputs for this environment (see controller_tf_input).
controller_plan_allowlist() {
  require_uint CURRENT_COUNT "$1" 0 100000
  require_uint EXPECTED_ADDS "$2" 0 100000
  require_uint CAP "$3" 0 100000
  if [[ -z "${4:-}" || -z "${5:-}" || -z "${6:-}" || -z "${7:-}" ]]; then
    echo "controller_plan_allowlist: server name, server type, location and environment are required" >&2
    return 1
  fi
  local verdict
  verdict="$(jq -r --argjson cur "$1" --argjson exp "$2" --argjson cap "$3" \
    --arg sn "$4" --arg st "$5" --arg loc "$6" --arg env "$7" "${_CONTROLLER_ALLOWLIST_JQ}")" \
    || return 1
  [[ "${verdict}" == "allowlist_ok" ]]
}

# ─── Demand sourcing (GET only) ───────────────────────────────────────────────

CONTROLLER_MAX_DEMAND_JOBS=200

# Builds one ask per task group from a Nomad job. A group is placement-plain only when no
# constraint, affinity or spread exists at job, group or task level; anything else is
# treated as not matching the node template (conservative).
_CONTROLLER_ASK_JQ='
def num: type == "number" and . >= 1 and . == floor;
if type != "object" then error("job response is not an object") else . end
| (((.Constraints // []) + (.Affinities // []) + (.Spreads // [])) | length == 0) as $job_plain
| if ((.TaskGroups // []) | type) != "array" then error("job without TaskGroups") else . end
| [ (.TaskGroups // [])[]
    | . as $g
    | ([($g.Tasks // [])[] | .Resources.MemoryMB]) as $mems
    | ([($g.Tasks // [])[] | .Resources.CPU]) as $cpus
    | ((($g.Constraints // []) + ($g.Affinities // []) + ($g.Spreads // []))
        + ([($g.Tasks // [])[] | ((.Constraints // []) + (.Affinities // []) + (.Spreads // []))] | add // [])
      | length == 0) as $group_plain
    | { namespace: $ns, jobId: $job, taskGroup: $g.Name,
        memory_mb: ($mems | add), cpu_mhz: ($cpus | add),
        placement_matches_template: ($job_plain and $group_plain) } ]
| if ([.[] | (.memory_mb | num), (.cpu_mhz | num), (.taskGroup | type == "string")] | all)
  then . else error("task group without usable MemoryMB, CPU or name") end
'

# controller_fetch_demand NAMESPACE
#   Prints {"evaluations", "asks"} for demand_classify. GET only. Reads the blocked and
#   failed evaluations in NAMESPACE, then each distinct job once for its task groups.
#   Fails closed: an unreadable job, an unsafe job id or too many jobs is an error.
controller_fetch_demand() {
  local ns="$1" evals jobs_json job job_json asks="[]" part count
  if [[ ! "${ns}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "controller_fetch_demand: invalid namespace" >&2
    return 1
  fi
  evals="$(nomad_api GET "/v1/evaluations?namespace=${ns}")" || return 1
  jq -e 'type == "array"' <<< "${evals}" >/dev/null || {
    echo "controller_fetch_demand: evaluations response is not an array" >&2
    return 1
  }
  jobs_json="$(jq -c '[.[] | select(.Status == "blocked" or .Status == "failed") | .JobID] | unique' \
    <<< "${evals}")" || return 1
  count="$(jq 'length' <<< "${jobs_json}")" || return 1
  if (( count > CONTROLLER_MAX_DEMAND_JOBS )); then
    echo "controller_fetch_demand: ${count} jobs with unplaced work exceeds ${CONTROLLER_MAX_DEMAND_JOBS}; refusing" >&2
    return 1
  fi
  while IFS= read -r job; do
    if [[ ! "${job}" =~ ^[A-Za-z0-9._-]+$ ]]; then
      echo "controller_fetch_demand: unsafe job id; refusing" >&2
      return 1
    fi
    job_json="$(nomad_api GET "/v1/job/${job}?namespace=${ns}")" || return 1
    part="$(jq -c --arg ns "${ns}" --arg job "${job}" "${_CONTROLLER_ASK_JQ}" <<< "${job_json}")" \
      || { echo "controller_fetch_demand: job ${job} has no usable task groups; refusing" >&2; return 1; }
    asks="$(jq -c -n --argjson a "${asks}" --argjson b "${part}" '$a + $b')" || return 1
  done < <(jq -r '.[]' <<< "${jobs_json}")
  jq -c -n --argjson e "${evals}" --argjson a "${asks}" '{evaluations: $e, asks: $a}'
}

# ─── Durable state (mutate mode only) ─────────────────────────────────────────

# _controller_write_file PATH CONTENT — atomic private write.
_controller_write_file() {
  local path="$1" content="$2" dir tmp
  dir="$(dirname "${path}")"
  mkdir -p "${dir}"
  tmp="$(umask 077; mktemp "${dir}/.state.XXXXXX")" || return 1
  if ! ( umask 077; printf '%s\n' "${content}" > "${tmp}" ) \
     || ! mv -f "${tmp}" "${path}"; then
    rm -f "${tmp}"
    return 1
  fi
}

# _controller_require_epoch VALUE — epoch seconds up to 10 digits. require_uint allows only 9 digits,
# which rejects every current Unix timestamp, so the controller checks its own bound.
_controller_require_epoch() {
  # Same grammar as require_uint (no leading zeros), with a 10-digit bound because epochs need it.
  if [[ ! "$1" =~ ^(0|[1-9][0-9]{0,9})$ ]] || (( 10#$1 > 9999999999 )); then
    die "NOW='$1' must be an integer epoch from 0 to 9999999999." 2
  fi
}

# controller_failure_backoff_active NOW — 0 while a recent failed scale-out is still backing off.
# An unreadable or corrupt failure record fails closed (treated as backing off).
controller_failure_backoff_active() {
  _controller_require_epoch "$1"
  [[ -f "${CONTROLLER_FAILURE_FILE}" ]] || return 1
  local last
  if ! last="$(cat "${CONTROLLER_FAILURE_FILE}")" || [[ ! "${last}" =~ ^(0|[1-9][0-9]{0,9})$ ]]; then
    echo "capacity-controller: failure record unreadable or corrupt; failing closed" >&2
    return 0
  fi
  (( $1 - last < NOMAD_SCALE_OUT_FAILURE_BACKOFF_SECONDS ))
}

# controller_record_failure NOW — starts the failure backoff window.
controller_record_failure() {
  _controller_require_epoch "$1"
  _controller_write_file "${CONTROLLER_FAILURE_FILE}" "$1"
}

# controller_streak_read — prints the consecutive capacity_blocked count (0 when absent).
# A corrupt file fails closed rather than resetting the streak silently.
controller_streak_read() {
  [[ -f "${CONTROLLER_STREAK_FILE}" ]] || { echo 0; return 0; }
  local value
  value="$(cat "${CONTROLLER_STREAK_FILE}")" || return 1
  [[ "${value}" =~ ^(0|[1-9][0-9]{0,5})$ ]] || return 1
  echo "${value}"
}

# controller_streak_observe STATUS — counts consecutive capacity_blocked ticks; any other
# status resets the streak.
controller_streak_observe() {
  local current next
  current="$(controller_streak_read)" || return 1
  if [[ "$1" == "capacity_blocked" ]]; then
    next=$(( current + 1 ))
  else
    next=0
  fi
  _controller_write_file "${CONTROLLER_STREAK_FILE}" "${next}"
}

# controller_streak_mature — 0 once the streak reaches NOMAD_DEMAND_CONSECUTIVE_OBSERVATIONS.
controller_streak_mature() {
  local current
  current="$(controller_streak_read)" || return 1
  (( current >= NOMAD_DEMAND_CONSECUTIVE_OBSERVATIONS ))
}

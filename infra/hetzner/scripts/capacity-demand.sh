#!/usr/bin/env bash
# capacity-demand.sh — Pure demand classification and per-node fit for agent placement.
#
# Source after scale-common.sh (uses require_uint from it). Nothing here touches the
# network or the filesystem. JSON is read by jq from stdin or from printf text, and
# operator-supplied numbers pass require_uint before any arithmetic.
#
# Functions:
#   demand_classify NAMESPACE READY_NODES TEMPLATE_MEMORY_MB TEMPLATE_CPU_MHZ
#       stdin:  {"evaluations": [Nomad evaluation objects], "asks": [ask objects]}
#       ask:    {"namespace", "jobId", "taskGroup", "memory_mb", "cpu_mhz",
#                "placement_matches_template"}
#       prints: {"namespace", "rows", "queued_allocs_by_class"}, one row per
#               (jobId, taskGroup). Exit 2 for an invalid argument; non-zero for invalid JSON.
#   capacity_node_fit
#       stdin:  {"node": Nomad node object, "allocations": [Nomad allocation objects]}
#       prints total, reserved, allocated and free memory and CPU for one node.
#       Non-zero exit if a required figure is missing or an allocation status is unrecognised.
#   capacity_node_slots FREE_MEMORY_MB FREE_CPU_MHZ SLOT_MEMORY_MB SLOT_CPU_MHZ
#       prints the whole slots that fit one node's free figures.
#   capacity_plan_fit TEMPLATE_MEMORY_MB TEMPLATE_CPU_MHZ
#       stdin:  {"bins": [{"id", "kind", "free_memory_mb", "free_cpu_mhz"}],
#                "items": [{"key", "memory_mb", "cpu_mhz", "count"}]}
#       kind:   "actual" (a ready node) or "viable" (in-flight, can still take work). New nodes
#               come only from the template; a "new" input bin is refused.
#       items:  memory_mb and cpu_mhz are integers from 1; count is an integer from 0 to 100000.
#       prints: {"placed_existing", "placed_on_new_nodes", "new_nodes_needed", "unplaceable"}
#       First-fit decreasing: items sorted by memory, then CPU, then key. Existing bins
#       are tried in [kind, id] order, then hypothetical nodes built from the template.
#       Cluster-wide free figures are never divided into slots.

_DEMAND_CLASSIFY_JQ='
def dimension_names: (.DimensionExhausted // {}) | keys;
def classify($rep; $ask):
  $rep.queued as $q
  | $rep.metric as $m
  | if $q == null then ["unclassified", "queued count not reported"]
    elif $q == 0 then ["already_assigned", "no queued allocations"]
    elif $ask == null then ["unclassified", "request size not reported"]
    elif $ask.memory_mb > $tmem or $ask.cpu_mhz > $tcpu then ["not_capacity_remediable", "request is larger than the node template"]
    elif $ask.placement_matches_template != true then ["not_capacity_remediable", "datacenter, node class or driver does not match the template"]
    elif (($m.QuotaExhausted // []) | length) > 0 then ["not_capacity_remediable", "namespace quota exhausted"]
    elif $ready == 0 then ["capacity_blocked", "no ready nodes"]
    elif ($m == null or ($m | length) == 0) then ["unclassified", "no placement diagnostics"]
    elif ($m | dimension_names | any(. != "memory" and . != "cpu")) then ["unclassified", "unrecognised exhausted dimension"]
    elif (($m | dimension_names | length) > 0) and (($m.NodesExhausted // 0) > 0) then ["capacity_blocked", "memory or CPU exhausted on evaluated nodes"]
    elif (($m | dimension_names | length) == 0) and (($m.NodesExhausted // 0) == 0)
      and (($m.NodesEvaluated // 0) > 0) and (($m.NodesFiltered // 0) >= $m.NodesEvaluated)
      then ["not_capacity_remediable", "every evaluated node was filtered by constraints"]
    else ["unclassified", "diagnostics do not show capacity exhaustion"]
    end;

(.evaluations // null) as $evals
| (.asks // null) as $asks
| if ($evals | type) != "array" or ($asks | type) != "array" then error("evaluations and asks must be arrays") else . end
| [ $evals[]
    | if (.Namespace | type) != "string" then error("evaluation without Namespace") else . end
    | select(.Namespace == $ns)
    | if (.ID | type) != "string" or (.JobID | type) != "string" then error("evaluation without ID or JobID") else . end
    | . as $e
    | (((.QueuedAllocations // {}) | keys) + ((.FailedTGAllocs // {}) | keys) | unique)[] as $tg
    | { job: $e.JobID, tg: $tg, eval_id: $e.ID, status: $e.Status,
        modify_index: ($e.ModifyIndex // 0),
        queued: (.QueuedAllocations // {})[$tg],
        metric: (.FailedTGAllocs // {})[$tg] }
    | if (.queued != null and (.queued | type) != "number") then error("queued count is not a number") else . end
  ]
| group_by([.job, .tg])
| [ .[] as $g
    | ([$g[] | select(.status != "canceled")] | sort_by([.modify_index, .eval_id]) | last) as $rep
    | select($rep != null)
    | [$asks[] | select(.namespace == $ns and .jobId == $rep.job and .taskGroup == $rep.tg)] as $m
    | if ($m | length) > 1 then error("more than one ask for a task group") else . end
    | if ($m[0] != null) and ((($m[0].memory_mb | type) != "number") or (($m[0].cpu_mhz | type) != "number"))
      then error("ask figures are not numbers") else . end
    | ($m[0]) as $ask
    | classify($rep; $ask) as $c
    | { namespace: $ns, jobId: $rep.job, taskGroup: $rep.tg,
        queued: $rep.queued, class: $c[0], reason: $c[1],
        memory_mb: $ask.memory_mb, cpu_mhz: $ask.cpu_mhz,
        evaluation_ids: ([$g[].eval_id] | unique) }
  ]
| . as $rows
| { namespace: $ns,
    rows: $rows,
    queued_allocs_by_class: (
      ["capacity_blocked", "not_capacity_remediable", "unclassified", "already_assigned"]
      | map(. as $k | { key: $k, value: ([$rows[] | select(.class == $k) | (.queued // 0)] | add // 0) })
      | from_entries) }
'

# Node allocation statuses per Nomad: pending, running, complete, failed, lost, unknown.
# pending, running and unknown occupy the node. An unknown status is not guessed at.
_CAPACITY_NODE_FIT_JQ='
def is_fig($lo; $hi): type == "number" and . >= $lo and . <= $hi and . == floor;
def is_known_status: . as $s | ["pending", "running", "unknown", "complete", "failed", "lost"] | any(. == $s);
def occupies: .ClientStatus == "pending" or .ClientStatus == "running" or .ClientStatus == "unknown";
def tasks: (.AllocatedResources.Tasks // {}) | [.[]];
def alloc_memory:
  tasks as $t
  | if ($t | length) > 0 then ([$t[].Memory.MemoryMB] | if any(is_fig(0; 999999999) | not) then null else add end)
    elif (.Resources.Memory.MemoryMB | is_fig(0; 999999999)) then .Resources.Memory.MemoryMB
    else null end;
def alloc_cpu:
  tasks as $t
  | if ($t | length) > 0 then ([$t[].Cpu.CpuShares] | if any(is_fig(0; 999999999) | not) then null else add end)
    elif (.Resources.Cpu.CpuShares | is_fig(0; 999999999)) then .Resources.Cpu.CpuShares
    else null end;

.node as $n
| .allocations as $allocs
| if ($allocs | type) != "array" then error("allocations must be an array") else . end
| if ([$allocs[] | .ClientStatus | is_known_status] | all) then . else error("unrecognised allocation status") end
| ($n.NodeResources.Memory.MemoryMB) as $tmem
| ($n.NodeResources.Cpu.CpuShares) as $tcpu
| if ($tmem | is_fig(1; 999999999)) then . else error("node memory figure missing or not a whole number") end
| if ($tcpu | is_fig(1; 999999999)) then . else error("node CPU figure missing or not a whole number") end
| ($n.ReservedResources.Memory.MemoryMB | if . == null then 0 else . end) as $rmem
| ($n.ReservedResources.Cpu.CpuShares | if . == null then 0 else . end) as $rcpu
| if ($rmem | is_fig(0; 999999999)) then . else error("reserved memory must be a whole number from 0") end
| if ($rcpu | is_fig(0; 999999999)) then . else error("reserved CPU must be a whole number from 0") end
| [$allocs[] | select(occupies)] as $occ
| [$occ[] | alloc_memory] as $mems
| [$occ[] | alloc_cpu] as $cpus
| if ($mems | any(. == null)) then error("allocation without a valid memory figure") else . end
| if ($cpus | any(. == null)) then error("allocation without a valid CPU figure") else . end
| ($mems | add // 0) as $amem
| ($cpus | add // 0) as $acpu
| { id: $n.ID,
    total_memory_mb: $tmem, reserved_memory_mb: $rmem, allocated_memory_mb: $amem,
    free_memory_mb: ([$tmem - $rmem - $amem, 0] | max),
    total_cpu_mhz: $tcpu, reserved_cpu_mhz: $rcpu, allocated_cpu_mhz: $acpu,
    free_cpu_mhz: ([$tcpu - $rcpu - $acpu, 0] | max) }
'

_CAPACITY_PLAN_FIT_JQ='
def fits($b; $i): $i.memory_mb <= $b.free_memory_mb and $i.cpu_mhz <= $b.free_cpu_mhz;
def take($b; $i): $b | .free_memory_mb -= $i.memory_mb | .free_cpu_mhz -= $i.cpu_mhz;
def first_fit($bins; $i):
  [range(0; ($bins | length)) as $k | select(fits($bins[$k]; $i)) | $k] | .[0] // -1;
def kind_rank: if . == "actual" then 0 elif . == "viable" then 1 else 2 end;
def is_int($lo; $hi): type == "number" and . >= $lo and . <= $hi and . == floor;

. as $in
| if ($in.bins | type) != "array" or ($in.items | type) != "array" then error("bins and items must be arrays") else . end
| if ([$in.bins[] | (.free_memory_mb, .free_cpu_mhz)] | any(type != "number")) then error("bin figures must be numbers") else . end
| if ([$in.bins[] | .kind] | any(. != "actual" and . != "viable")) then error("bin kind must be actual or viable") else . end
| if ([$in.items[] | (.memory_mb, .cpu_mhz, .count)] | any(type != "number")) then error("item figures must be numbers") else . end
| if ([$in.items[]
       | ((.memory_mb | is_int(1; 999999999)) and (.cpu_mhz | is_int(1; 999999999)) and (.count | is_int(0; 100000)))]
      | all | not)
  then error("item memory_mb and cpu_mhz must be integers from 1, and count an integer from 0 to 100000")
  else . end
| ($in.bins | sort_by([(.kind | kind_rank), .id])) as $bins
| ([$in.items[] | . as $it
     | range($it.count) as $n
     | { key: ($it.key + "#" + ($n | tostring)), memory_mb: $it.memory_mb, cpu_mhz: $it.cpu_mhz }]
   | sort_by([-.memory_mb, -.cpu_mhz, .key])) as $items
| reduce $items[] as $i (
    { bins: $bins, new: [], placed_existing: 0, placed_on_new_nodes: 0, unplaceable: [] };
    if ($i.memory_mb > $tmem or $i.cpu_mhz > $tcpu) then .unplaceable += [$i.key]
    else (first_fit(.bins; $i)) as $e
      | if $e >= 0 then (.bins[$e] |= take(.; $i) | .placed_existing += 1)
        else (first_fit(.new; $i)) as $n
          | if $n >= 0
            then (.new[$n] |= take(.; $i) | .placed_on_new_nodes += 1)
            else (.new += [take({ free_memory_mb: $tmem, free_cpu_mhz: $tcpu }; $i)] | .placed_on_new_nodes += 1)
            end
        end
    end)
| { placed_existing, placed_on_new_nodes, new_nodes_needed: (.new | length), unplaceable }
'

# demand_classify NAMESPACE READY_NODES TEMPLATE_MEMORY_MB TEMPLATE_CPU_MHZ
demand_classify() {
  local namespace="$1"
  if [[ ! "${namespace}" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]]; then
    echo "demand_classify: invalid namespace" >&2
    return 2
  fi
  require_uint READY_NODES "$2" 0 100000
  require_uint TEMPLATE_MEMORY_MB "$3" 1 100000
  require_uint TEMPLATE_CPU_MHZ "$4" 1 100000
  jq -c --arg ns "${namespace}" --argjson ready "$2" \
    --argjson tmem "$3" --argjson tcpu "$4" "${_DEMAND_CLASSIFY_JQ}"
}

# capacity_node_fit
#   stdin: {"node": Nomad node object, "allocations": [Nomad allocation objects]}
capacity_node_fit() {
  jq -c "${_CAPACITY_NODE_FIT_JQ}"
}

# capacity_node_slots FREE_MEMORY_MB FREE_CPU_MHZ SLOT_MEMORY_MB SLOT_CPU_MHZ
capacity_node_slots() {
  require_uint FREE_MEMORY_MB "$1" 0 999999999
  require_uint FREE_CPU_MHZ "$2" 0 999999999
  require_uint SLOT_MEMORY_MB "$3" 1 100000
  require_uint SLOT_CPU_MHZ "$4" 1 100000
  local by_memory=$(( $1 / $3 ))
  local by_cpu=$(( $2 / $4 ))
  if (( by_memory < by_cpu )); then
    echo "${by_memory}"
  else
    echo "${by_cpu}"
  fi
}

# capacity_plan_fit TEMPLATE_MEMORY_MB TEMPLATE_CPU_MHZ
capacity_plan_fit() {
  require_uint TEMPLATE_MEMORY_MB "$1" 1 100000
  require_uint TEMPLATE_CPU_MHZ "$2" 1 100000
  jq -c --argjson tmem "$1" --argjson tcpu "$2" "${_CAPACITY_PLAN_FIT_JQ}"
}

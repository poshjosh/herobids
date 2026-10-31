#!/usr/bin/env bash
# scale-in-guard.sh — pure checks for scale-in (sourced, no side effects).
#
#   scale_in_leading_run          stdin "<suffix> <ok>" lines, highest suffix first.
#                                 Prints the length of the leading run of ok=1
#                                 lines with consecutive suffixes.
#   scale_in_plan_validate C N D B  stdin: `terraform show -json` of the saved scale-in
#                                 plan. C = current count, N = new count, D = CSV of
#                                 the drained Terraform indices, B = CSV of
#                                 `index=server-name` bindings. Returns 0 only when
#                                 the plan deletes exactly the drained suffix N..C-1
#                                 and each deleted server is the bound Nomad node.
#                                 Violations are printed to stderr. Fails closed.
#   scale_in_new_count_ok C N MIN true only when MIN <= N < C.
#   scale_in_names_unique         stdin: one name per line. Empty input is valid;
#                                 an empty or repeated name fails.

# Terraform indices are 0-based; the server name suffix is index + 1 (main.tf).
# Only count-based agent resources are allowed to change, and only as deletes.
# shellcheck disable=SC2016  # the jq program is intentionally single-quoted
_SCALE_IN_PLAN_JQ='
def agent_res:
  (.mode == "managed") and ((.module_address // "") == "") and (.name == "agent")
  and ((.type == "hcloud_server") or (.type == "hcloud_server_network"));
def actions: (.change.actions // []);
def bindmap: ($bind | split(",") | map(split("=") | {key: .[0], value: .[1]}) | from_entries);
(if (.resource_changes | type) != "array" then
  ["plan has no resource_changes array"]
else
  .resource_changes as $rcs
  | ($rcs | map(select(agent_res and .type == "hcloud_server" and actions == ["delete"]) | .index) | sort) as $dels
  | [
      (if ((.variables.agent_node_count.value // null) | tostring) != ($new | tostring)
         then "planned agent_node_count is not \($new)" else empty end),
      (if [range($new; $cur)] != ($exp | sort)
         then "drained set \($exp | sort) is not the contiguous suffix \($new)..\($cur - 1)" else empty end),
      (if $dels != ($exp | sort)
         then "server delete indices \($dels) are not the drained suffix \($exp | sort)" else empty end),
      ($rcs[] | select(agent_res | not) | select(actions != ["no-op"] and actions != ["read"])
         | "unexpected change to \(.address): actions=\(actions | tojson)"),
      ($rcs[] | select(agent_res) | select(actions != ["delete"] and actions != ["no-op"] and actions != ["read"])
         | "non-delete change to \(.address): actions=\(actions | tojson)"),
      ($rcs[] | select(agent_res and (actions == ["no-op"] or actions == ["read"]))
         | select(.index == null or .index >= $new)
         | "surviving \(.type) at index \(.index) is not kept"),
      ($rcs[] | select(agent_res and .type == "hcloud_server_network" and actions == ["delete"])
         | select(.index as $i | ($exp | any(. == $i)) | not)
         | "network delete at index \(.index) is outside the drained suffix"),
      (if (bindmap | keys | map(tonumber) | sort) != ($exp | sort)
         then "name bindings \(bindmap | keys) are not the drained set \($exp | sort)" else empty end),
      ($rcs[] | select(agent_res and .type == "hcloud_server" and actions == ["delete"])
         | select((.change.before.name // null) != bindmap[(.index | tostring)])
         | "server at index \(.index) is named \(.change.before.name // "unnamed") but bound to \(bindmap[(.index | tostring)] // "nothing")")
    ]
end) | .[]
'

# scale_in_leading_run — counts consecutive ok=1 suffixes from the top of the list.
scale_in_leading_run() {
  local idx ok prev="" run=0
  # "|| [[ -n ]]" keeps a final line that has no trailing newline.
  while read -r idx ok || [[ -n "${idx}" ]]; do
    [[ "${idx}" =~ ^[0-9]+$ && "${ok}" == "1" ]] || break
    if [[ -n "${prev}" && "${idx}" -ne $(( prev - 1 )) ]]; then
      break
    fi
    run=$(( run + 1 ))
    prev="${idx}"
  done
  echo "${run}"
}

scale_in_new_count_ok() {
  local cur="$1" new="$2" min="$3"
  [[ "${cur}" =~ ^[0-9]+$ && "${new}" =~ ^[0-9]+$ && "${min}" =~ ^[0-9]+$ ]] || return 1
  (( new >= min && new < cur ))
}

# scale_in_names_unique — reads one name per line. Empty input is valid.
scale_in_names_unique() {
  local name seen=$'\n'
  while IFS= read -r name || [[ -n "${name}" ]]; do
    [[ -n "${name}" ]] || return 1
    case "${seen}" in *$'\n'"${name}"$'\n'*) return 1 ;; esac
    seen="${seen}${name}"$'\n'
  done
  return 0
}

scale_in_plan_validate() {
  local cur="$1" new="$2" drained="$3" bindings="${4:-}" violations line plan_json
  local int_re='^[0-9]+$' csv_re='^[0-9]+(,[0-9]+)*$'
  local bind_re='^[0-9]+=[A-Za-z0-9][A-Za-z0-9._-]*(,[0-9]+=[A-Za-z0-9][A-Za-z0-9._-]*)*$'

  if ! [[ "${cur}" =~ ${int_re} && "${new}" =~ ${int_re} ]] || [[ "${new}" -ge "${cur}" ]]; then
    echo "  - scale-in counts are invalid: current=${cur} new=${new}" >&2
    return 1
  fi
  if ! [[ "${drained}" =~ ${csv_re} ]]; then
    echo "  - drained index list is malformed: '${drained}'" >&2
    return 1
  fi
  # A missing or malformed binding means the server-to-node link is unproven: refuse.
  if ! [[ "${bindings}" =~ ${bind_re} ]]; then
    echo "  - server name bindings are missing or malformed: '${bindings}'" >&2
    return 1
  fi
  # Empty input would make jq print nothing and pass, so it is refused explicitly.
  plan_json="$(cat)"
  if [[ -z "${plan_json}" ]]; then
    echo "  - saved plan JSON is empty" >&2
    return 1
  fi
  if ! violations="$(printf '%s' "${plan_json}" | jq -r --argjson cur "${cur}" \
      --argjson new "${new}" --argjson exp "[${drained}]" --arg bind "${bindings}" \
      "${_SCALE_IN_PLAN_JQ}")"; then
    echo "  - saved plan JSON could not be parsed" >&2
    return 1
  fi
  if [[ -n "${violations}" ]]; then
    while IFS= read -r line; do
      echo "  - ${line}" >&2
    done <<< "${violations}"
    return 1
  fi
  return 0
}

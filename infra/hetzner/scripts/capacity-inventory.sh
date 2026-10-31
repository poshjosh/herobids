#!/usr/bin/env bash
# capacity-inventory.sh — Reconciled managed inventory, in-flight state and
# readiness accounting for the agent pool.
#
# Source after scale-common.sh (uses log and die from it). Everything here is
# read-only except the in-flight record writers, which touch only the state
# file under NOMAD_AUTOSCALE_STATE_DIR.
#
# Model:
#   managed   every live Hetzner server carrying the herobids labels for this
#             environment and pool (app, environment, role=agent,
#             node_pool), including down, unjoined and booting servers.
#   ready     a managed server whose Nomad node is ready and eligible.
#   in-flight a provisioning request recorded with a deadline measured from
#             its requested_epoch, and the server IDs observed after apply.
#             Only those observed servers can satisfy it. A restart reads the
#             same deadline back; it never starts a fresh one.
#
# The cached agent_node_count is not an input. Collection failures are errors,
# never zero: an unreadable inventory must not look like an empty pool.
#
# Functions:
#   capacity_fetch_cloud_servers ENV          GET-only Hetzner read (normalised)
#   capacity_fetch_nomad_nodes                GET-only Nomad read
#   capacity_reconcile CLOUD NOMAD DECLARED ENV POOL NOW [INFLIGHT]
#                                             prints snapshot JSON; exit 0
#                                             consistent, 2 blocked, 1 invalid
#                                             DECLARED is an integer or "-"
#   capacity_inflight_read FILE ENV POOL      prints record, or nothing if none
#   capacity_inflight_begin FILE ENV POOL TARGET BASELINE NOW TIMEOUT
#   capacity_inflight_record_servers FILE ENV POOL IDS_JSON
#   capacity_inflight_clear FILE STATE        removes the record only for ready or expired
#   capacity_observe_after_apply FILE ENV POOL BASELINE_IDS_JSON
#   capacity_scale_gate ENV POOL NOW MUTATE   decision gate used by scale-out and scale-in
#                                             exit 0 proceed, 2 pending, 3 refuse, 1 unreadable

_CAPACITY_MAX_PAGES=100

_capacity_valid_identifier() {
  [[ "$1" =~ ^[a-z][a-z0-9-]*$ ]]
}

_capacity_valid_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

# Reads a record on stdin. Succeeds only for a complete, structurally valid
# record for this environment and pool.
_capacity_record_ok() {
  jq -e --arg env "$1" --arg pool "$2" '
    .schema_version == 1
    and .environment == $env and .pool == $pool
    and (.target_count | type == "number") and .target_count >= 1
    and (.baseline_count | type == "number") and .baseline_count >= 0
    and .target_count > .baseline_count
    and (.requested_epoch | type == "number")
    and (.deadline_epoch | type == "number")
    and (.server_ids | type == "array")
    and (.server_ids | all(type == "number"))' >/dev/null 2>&1
}

capacity_fetch_cloud_servers() {
  local env="$1"
  local base="${HCLOUD_API_URL:-https://api.hetzner.cloud/v1}"
  local page=1 pages="" body items next

  if ! _capacity_valid_identifier "${env}"; then
    echo "capacity_fetch_cloud_servers: invalid environment" >&2
    return 1
  fi
  if [[ -z "${HCLOUD_TOKEN:-}" ]]; then
    echo "capacity_fetch_cloud_servers: HCLOUD_TOKEN is not set" >&2
    return 1
  fi
  # The token is written into a curl config header, so these characters would
  # break out of the quoted value.
  if [[ "${HCLOUD_TOKEN}" == *'"'* || "${HCLOUD_TOKEN}" == *'\'* || "${HCLOUD_TOKEN}" == *$'\n'* ]]; then
    echo "capacity_fetch_cloud_servers: HCLOUD_TOKEN contains characters that cannot be passed safely" >&2
    return 1
  fi

  # The bearer token travels on curl's stdin config, so it never appears in
  # argv or the process table.
  while (( page <= _CAPACITY_MAX_PAGES )); do
    body="$(printf 'header = "Authorization: Bearer %s"\n' "${HCLOUD_TOKEN}" \
      | curl -sS --fail --connect-timeout 10 --max-time 30 -K - \
        "${base}/servers?label_selector=app=herobids,environment=${env}&per_page=50&page=${page}")" \
      || return 1
    # jq exits 0 on empty input, so an empty or truncated body must be
    # rejected here rather than read as an empty inventory.
    jq -e '.servers | type == "array"' <<< "${body}" >/dev/null || return 1
    items="$(jq -c '[.servers[] | {id, name, status, labels, address: (.public_net.ipv4.ip // null)}]' \
      <<< "${body}")" || return 1
    pages+="${items}"$'\n'

    next="$(jq -r '.meta.pagination.next_page // empty' <<< "${body}")" || return 1
    if [[ -z "${next}" ]]; then
      jq -s -c 'add // []' <<< "${pages}" || return 1
      return 0
    fi
    if ! _capacity_valid_integer "${next}" || (( next <= page )); then
      echo "capacity_fetch_cloud_servers: pagination did not advance; refusing a partial inventory" >&2
      return 1
    fi
    page="${next}"
  done

  echo "capacity_fetch_cloud_servers: more than ${_CAPACITY_MAX_PAGES} pages; refusing a partial inventory" >&2
  return 1
}

capacity_fetch_nomad_nodes() {
  local nodes
  nodes="$(nomad_api GET "/v1/nodes")" || return 1
  jq -e 'type == "array"' <<< "${nodes}" >/dev/null || return 1
  printf '%s\n' "${nodes}"
}

# The program reads its inputs from named arguments and one stdin document, so
# no shell value is spliced into the jq source.
_CAPACITY_RECONCILE_JQ='
def owned: .labels.app == "herobids" and .labels.environment == $env;
def shaped:
  .labels.role == "agent" and .labels.node_pool == $pool
  and ((.name // "") | test("^" + $pool + "-agent-[0-9]+$"));
def index_of: .name | capture("-agent-(?<i>[0-9]+)$").i | tonumber;
def nomad_state($node):
  if $node == null then "unjoined"
  elif $node.Status == "down" then "down"
  elif $node.Status == "ready" and $node.SchedulingEligibility == "eligible" then "ready"
  else "joined_not_ready" end;

. as $in
| $in.cloud as $cloud
| $in.nomad as $nomad
| $in.inflight as $inflight
| (if $declared == "-" then null else ($declared | tonumber) end) as $decl
| ($cloud | map(select(owned))) as $owned
| ($owned | map(select(.status == "deleting"))) as $deleting
| ($owned | map(select(.status != "deleting"))) as $live
| ($live | map(select(shaped | not))) as $foreign
| ($live | map(select(shaped)) | map(. + {index: index_of})) as $managed
| ($managed | map(. as $s | {
    name: $s.name, id: $s.id, address: $s.address, cloud_status: $s.status, index: $s.index,
    nomad: nomad_state(([$nomad[] | select(.Name == $s.name)] | first) // null)
  }) | sort_by(.index)) as $servers
| ($servers | length) as $n
| ($servers | map(.index) | sort) as $indices
| [range(1; $n + 1)] as $expected
| ($servers | map(.name)) as $names
| [$nomad[]
    | select((.Name | type) == "string")
    | select(.Name | test("^" + $pool + "-agent-[0-9]+$"))
    | . as $node
    | select(($names | any(. == $node.Name)) | not)] as $orphans
| ($orphans | map(select(.Status != "down")) | length) as $orphan_live
| ($orphans | map(select(.Status == "down")) | length) as $orphan_down
| ($inflight.server_ids // []) as $sids
| ($servers | map(select(.nomad == "ready" and (. as $s | $sids | any(. == $s.id)))) | length) as $new_ready
| ($servers | map(select(.nomad == "ready")) | length) as $ready
| ($servers | map(select(.nomad == "down")) | length) as $down
| ($servers | map(select(.nomad == "unjoined")) | length) as $unjoined
| ($servers | map(select(.nomad == "joined_not_ready")) | length) as $joined_not_ready
| (if $inflight == null then 0 else ($inflight.target_count - $inflight.baseline_count) end) as $needed
| (if $inflight == null then "none"
   elif $new_ready >= $needed then "ready"
   elif $now <= $inflight.deadline_epoch then "pending"
   else "expired" end) as $rstate
| [
    if ($foreign | length) > 0 then "ownership_mismatch" else empty end,
    if $n == 0 then "empty_inventory" else empty end,
    if $indices != $expected then "noncontiguous_or_duplicate_indices" else empty end,
    if $decl != null and ($n > $decl or ($n != $decl and $rstate != "pending")) then "partial_apply" else empty end,
    if $orphan_live > 0 then "orphan_nomad_node" else empty end,
    if $inflight == null and $unjoined > 0 then "unjoined_without_record" else empty end,
    if $rstate == "expired" then "readiness_deadline_exceeded" else empty end
  ] as $blockers
| {
    schema_version: 1,
    environment: $env,
    pool: $pool,
    evaluated_at: $now,
    declared_count: $decl,
    managed_count: $n,
    ready_count: $ready,
    new_ready_count: $new_ready,
    not_ready_count: ($n - $ready),
    down_count: $down,
    unjoined_count: $unjoined,
    joined_not_ready_count: $joined_not_ready,
    deleting_count: ($deleting | length),
    stale_nomad_down_count: $orphan_down,
    in_flight: (if $inflight == null then null else {
      target_count: $inflight.target_count,
      baseline_count: $inflight.baseline_count,
      requested_epoch: $inflight.requested_epoch,
      deadline_epoch: $inflight.deadline_epoch,
      state: $rstate
    } end),
    status: (if ($blockers | length) == 0 then "consistent" else "blocked" end),
    blockers: $blockers,
    servers: $servers
  }
'

# capacity_reconcile CLOUD_JSON NOMAD_JSON DECLARED ENV POOL NOW [INFLIGHT_JSON]
#   CLOUD_JSON    normalised server array from capacity_fetch_cloud_servers
#   NOMAD_JSON    node array from capacity_fetch_nomad_nodes
#   DECLARED      integer declared count, or "-" when no declaration is known
#   NOW           evaluation time, epoch seconds (injected for determinism)
#   INFLIGHT_JSON optional record from capacity_inflight_read (empty = none)
capacity_reconcile() {
  local cloud="$1" nomad="$2" declared="$3" env="$4" pool="$5" now="$6"
  local inflight="${7:-}"
  local input snapshot

  if ! _capacity_valid_identifier "${env}" || ! _capacity_valid_identifier "${pool}"; then
    echo "capacity_reconcile: invalid environment or pool" >&2
    return 1
  fi
  if [[ "${declared}" != "-" ]] && ! _capacity_valid_integer "${declared}"; then
    echo "capacity_reconcile: declared count must be an integer or '-'" >&2
    return 1
  fi
  if ! _capacity_valid_integer "${now}"; then
    echo "capacity_reconcile: time must be a non-negative integer" >&2
    return 1
  fi
  # An empty input is a failed read, never an empty inventory.
  if [[ -z "${cloud}" || -z "${nomad}" ]]; then
    echo "capacity_reconcile: cloud or Nomad input is empty; refusing" >&2
    return 1
  fi
  if ! jq -e 'type == "array"' <<< "${cloud}" >/dev/null 2>&1 \
    || ! jq -e 'type == "array"' <<< "${nomad}" >/dev/null 2>&1; then
    echo "capacity_reconcile: cloud and Nomad inputs must be JSON arrays" >&2
    return 1
  fi
  if [[ -n "${inflight}" ]] && ! _capacity_record_ok "${env}" "${pool}" <<< "${inflight}"; then
    echo "capacity_reconcile: in-flight record is invalid or belongs to another environment or pool" >&2
    return 1
  fi

  # Large documents go over stdin, not argv.
  input="$(printf '{"cloud":%s,"nomad":%s,"inflight":%s}\n' \
    "${cloud}" "${nomad}" "${inflight:-null}")"
  snapshot="$(jq -c \
    --arg env "${env}" \
    --arg pool "${pool}" \
    --arg declared "${declared}" \
    --argjson now "${now}" \
    "${_CAPACITY_RECONCILE_JQ}" <<< "${input}")" || {
      echo "capacity_reconcile: reconcile failed" >&2
      return 1
    }

  printf '%s\n' "${snapshot}"
  if jq -e '.status == "consistent"' <<< "${snapshot}" >/dev/null; then
    return 0
  fi
  return 2
}

# capacity_inflight_read FILE ENV POOL
#   Prints the record when one exists, nothing when none does. A missing file
#   is the only "no record" case. Any other stat error, or a corrupt or
#   unsupported record, fails closed: it is never replayed or guessed at.
capacity_inflight_read() {
  local file="$1" env="$2" pool="$3"
  local err content

  if ! _capacity_valid_identifier "${env}" || ! _capacity_valid_identifier "${pool}"; then
    echo "capacity_inflight_read: invalid environment or pool" >&2
    return 1
  fi
  if ! err="$(stat "${file}" 2>&1 >/dev/null)"; then
    if [[ "${err}" == *"No such file or directory"* ]]; then
      return 0
    fi
    echo "capacity_inflight_read: cannot inspect ${file}: ${err}" >&2
    return 1
  fi
  if ! content="$(jq -c . "${file}" 2>/dev/null)" \
    || ! _capacity_record_ok "${env}" "${pool}" <<< "${content}"; then
    echo "capacity_inflight_read: ${file} is corrupt or unsupported; refusing to guess" >&2
    return 1
  fi
  printf '%s\n' "${content}"
}

# capacity_inflight_begin FILE ENV POOL TARGET BASELINE NOW TIMEOUT
#   Records a provisioning request. BASELINE is the managed count before the
#   apply. The record is created with no-clobber semantics: `ln` of a temp file
#   fails if a record already exists, so two concurrent begins cannot both win
#   and a new request cannot reset the deadline of one still in flight.
capacity_inflight_begin() {
  local file="$1" env="$2" pool="$3" target="$4" baseline="$5" now="$6" timeout="$7"
  local dir tmp record

  if ! _capacity_valid_identifier "${env}" || ! _capacity_valid_identifier "${pool}"; then
    echo "capacity_inflight_begin: invalid environment or pool" >&2
    return 1
  fi
  if ! _capacity_valid_integer "${target}" || ! _capacity_valid_integer "${baseline}" \
    || ! _capacity_valid_integer "${now}" || ! _capacity_valid_integer "${timeout}"; then
    echo "capacity_inflight_begin: target, baseline, time and timeout must be non-negative integers" >&2
    return 1
  fi
  if (( target < 1 || target <= baseline )); then
    echo "capacity_inflight_begin: target must be at least 1 and greater than the baseline" >&2
    return 1
  fi
  if [[ -e "${file}" ]]; then
    echo "capacity_inflight_begin: a record already exists at ${file}; clear it before a new request" >&2
    return 1
  fi

  dir="$(dirname "${file}")"
  mkdir -p "${dir}" || return 1
  tmp="$(mktemp "${dir}/.inflight.XXXXXX")" || return 1
  record="$(jq -n -c \
    --arg env "${env}" --arg pool "${pool}" \
    --argjson target "${target}" --argjson baseline "${baseline}" \
    --argjson now "${now}" --argjson deadline "$(( now + timeout ))" \
    '{schema_version: 1, environment: $env, pool: $pool,
      target_count: $target, baseline_count: $baseline,
      requested_epoch: $now, deadline_epoch: $deadline, server_ids: []}')" \
    && printf '%s\n' "${record}" > "${tmp}" \
    || { rm -f "${tmp}"; return 1; }
  sync
  if ! ln "${tmp}" "${file}" 2>/dev/null; then
    rm -f "${tmp}"
    echo "capacity_inflight_begin: a record appeared concurrently at ${file}; refusing" >&2
    return 1
  fi
  rm -f "${tmp}"
}

# capacity_inflight_record_servers FILE ENV POOL IDS_JSON
#   Stores the server IDs observed after apply. Replaces, never merges. The
#   write is atomic: temp file in the same directory, then rename.
capacity_inflight_record_servers() {
  local file="$1" env="$2" pool="$3" ids="$4"
  local current dir tmp

  if ! jq -e 'type == "array" and all(type == "number")' <<< "${ids}" >/dev/null 2>&1; then
    echo "capacity_inflight_record_servers: server IDs must be a numeric JSON array" >&2
    return 1
  fi
  current="$(capacity_inflight_read "${file}" "${env}" "${pool}")" || return 1
  if [[ -z "${current}" ]]; then
    echo "capacity_inflight_record_servers: no in-flight record to update" >&2
    return 1
  fi

  dir="$(dirname "${file}")"
  tmp="$(mktemp "${dir}/.inflight.XXXXXX")" || return 1
  if ! printf '%s\n%s\n' "${current}" "${ids}" \
    | jq -c -s '.[0] + {server_ids: .[1]}' > "${tmp}"; then
    rm -f "${tmp}"
    return 1
  fi
  sync
  mv -f "${tmp}" "${file}"
}

# capacity_inflight_clear FILE STATE
#   Removes the record only once its state is ready or expired. A pending
#   record is never cleared: it still gates scale-out until its deadline.
capacity_inflight_clear() {
  local file="$1" state="$2"
  case "${state}" in
    ready|expired)
      rm -f "${file}"
      ;;
    *)
      echo "capacity_inflight_clear: refusing to clear a record in state '${state}'" >&2
      return 1
      ;;
  esac
}

# capacity_observe_after_apply FILE ENV POOL BASELINE_IDS_JSON
#   Re-reads the cloud inventory after apply and records the IDs of the managed
#   servers that were not in the baseline. Only these can satisfy readiness. If
#   the re-read fails, nothing is recorded, so the record stays pending and then
#   expires; it is never treated as satisfied.
capacity_observe_after_apply() {
  local file="$1" env="$2" pool="$3" baseline="$4"
  local cloud ids

  if ! _capacity_valid_identifier "${env}" || ! _capacity_valid_identifier "${pool}"; then
    echo "capacity_observe_after_apply: invalid environment or pool" >&2
    return 1
  fi
  if ! jq -e 'type == "array" and all(type == "number")' <<< "${baseline}" >/dev/null 2>&1; then
    echo "capacity_observe_after_apply: baseline IDs must be a numeric JSON array" >&2
    return 1
  fi
  cloud="$(capacity_fetch_cloud_servers "${env}")" || return 1
  ids="$(printf '{"cloud":%s,"baseline":%s}\n' "${cloud}" "${baseline}" \
    | jq -c --arg env "${env}" --arg pool "${pool}" '
        .cloud as $cloud | .baseline as $base
        | [$cloud[]
            | select(.labels.app == "herobids" and .labels.environment == $env
                     and .labels.role == "agent" and .labels.node_pool == $pool
                     and .status != "deleting"
                     and ((.name // "") | test("^" + $pool + "-agent-[0-9]+$")))
            | .id
            | select(. as $id | ($base | any(. == $id)) | not)]')" || return 1
  capacity_inflight_record_servers "${file}" "${env}" "${pool}" "${ids}"
}

# capacity_scale_gate ENV POOL NOW MUTATE
#   Decides whether a scale action may proceed. Call it under the autoscale
#   lock. MUTATE=true may clear a ready or expired record; false is read-only.
#   Prints the snapshot on stdout. Exit codes:
#     0 proceed, 2 pending (wait), 3 refuse (blocked), 1 unreadable or invalid.
#   The declared count comes from the record alone. Nothing else is trusted.
capacity_scale_gate() {
  local env="$1" pool="$2" now="$3" mutate="$4"
  local file="${NOMAD_AUTOSCALE_INFLIGHT_FILE}"
  local cloud nomad record="" declared="-" snapshot state status rc=0

  if ! _capacity_valid_identifier "${env}" || ! _capacity_valid_identifier "${pool}" \
    || ! _capacity_valid_integer "${now}"; then
    echo "capacity_scale_gate: invalid environment, pool or time" >&2
    return 1
  fi
  if [[ "${mutate}" != "true" && "${mutate}" != "false" ]]; then
    echo "capacity_scale_gate: MUTATE must be true or false" >&2
    return 1
  fi

  cloud="$(capacity_fetch_cloud_servers "${env}")" || {
    echo "capacity_scale_gate: cloud inventory unavailable; refusing" >&2
    return 1
  }
  nomad="$(capacity_fetch_nomad_nodes)" || {
    echo "capacity_scale_gate: Nomad node inventory unavailable; refusing" >&2
    return 1
  }
  record="$(capacity_inflight_read "${file}" "${env}" "${pool}")" || return 1
  if [[ -n "${record}" ]]; then
    declared="$(jq -r '.target_count' <<< "${record}")" || return 1
  fi

  snapshot="$(capacity_reconcile "${cloud}" "${nomad}" "${declared}" "${env}" "${pool}" "${now}" "${record}")" \
    || rc=$?
  if (( rc == 1 )) || [[ -z "${snapshot}" ]]; then
    return 1
  fi
  state="$(jq -r '.in_flight.state // "none"' <<< "${snapshot}")" || return 1

  # The new nodes joined, so the record has done its job. Judge the pool on its
  # own from here on, without the record.
  if [[ "${state}" == "ready" ]]; then
    rc=0
    snapshot="$(capacity_reconcile "${cloud}" "${nomad}" "-" "${env}" "${pool}" "${now}")" || rc=$?
    if (( rc == 1 )) || [[ -z "${snapshot}" ]]; then
      return 1
    fi
  fi

  # Cleared here, after the second reconcile and before the blocked decision, so
  # a finished or expired record never outlives its use and is not re-judged.
  if [[ "${mutate}" == "true" && ( "${state}" == "ready" || "${state}" == "expired" ) ]]; then
    capacity_inflight_clear "${file}" "${state}" || return 1
  fi

  printf '%s\n' "${snapshot}"
  status="$(jq -r '.status' <<< "${snapshot}")" || return 1
  if [[ "${status}" == "blocked" ]]; then
    echo "capacity_scale_gate: pool blocked: $(jq -r '.blockers | join(", ")' <<< "${snapshot}"). See 'Clearing a blocked scale guard' in infra/hetzner/docs/auto-scaling/setup-auto-scaling.md" >&2
    return 3
  fi
  if [[ "${state}" == "pending" ]]; then
    return 2
  fi
  return 0
}

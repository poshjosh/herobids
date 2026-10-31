#!/usr/bin/env bash
# check-nomad-capacity.test.sh — Runs check-nomad-capacity.sh against a fake Nomad API.
#
# Fixtures copy the response shape of Nomad on staging (2026-10-30): each task's
# memory is under AllocatedResources, and Resources.Memory.MemoryMB is null.
#
# Usage: infra/hetzner/scripts/tests/check-nomad-capacity.test.sh

set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${CHECK_NOMAD_CAPACITY_SCRIPT:-${SCRIPTS_DIR}/check-nomad-capacity.sh}"
# Pin the pool so the fixture's Meta.node_pool matches regardless of the caller's environment.
export NOMAD_AUTOSCALE_NODE_POOL=herobids
PORT="${TEST_NOMAD_PORT:-47646}"
FAILURES=0
NOMAD_AUTOSCALE_LOG_FILE="$(mktemp)"
export NOMAD_AUTOSCALE_LOG_FILE
FAKE_SERVER="$(mktemp)"

write_fake_server() {
  cat > "$FAKE_SERVER" <<'PY'
import http.server, json, sys

NODE = {
    "ID": "node-1", "Status": "ready", "SchedulingEligibility": "eligible", "NodeClass": "agent",
    "Meta": {"node_pool": "herobids"},
    "NodeResources": {"Memory": {"MemoryMB": 3819}, "Cpu": {"CpuShares": 4000}},
    "ReservedResources": {"Memory": {"MemoryMB": 0}, "Cpu": {"CpuShares": 0}},
}
# Not an agent-class node: it must be excluded from the list, so it is never fetched.
OTHER_NODE_STUB = {"ID": "node-2", "Status": "ready", "SchedulingEligibility": "eligible", "NodeClass": "other"}
# Agent-class node in another pool: passes the list filter, so only the full object's
# Meta.node_pool keeps it out. Its allocations are served so that counting it would change the output.
OTHER_POOL_NODE = {
    "ID": "node-3", "Status": "ready", "SchedulingEligibility": "eligible", "NodeClass": "agent",
    "Meta": {"node_pool": "other-pool"},
    "NodeResources": {"Memory": {"MemoryMB": 3819}, "Cpu": {"CpuShares": 4000}},
    "ReservedResources": {"Memory": {"MemoryMB": 0}, "Cpu": {"CpuShares": 0}},
}

# Detail-down case: a healthy second herobids node, so the run exits 0 and node-1 is the only node that could be miscounted.
HEALTHY_NODE_B = {
    "ID": "node-4", "Status": "ready", "SchedulingEligibility": "eligible", "NodeClass": "agent",
    "Meta": {"node_pool": "herobids"},
    "NodeResources": {"Memory": {"MemoryMB": 3819}, "Cpu": {"CpuShares": 4000}},
    "ReservedResources": {"Memory": {"MemoryMB": 0}, "Cpu": {"CpuShares": 0}},
}

def task(mem):
    return {"Tasks": {"agent": {"Memory": {"MemoryMB": mem}, "Cpu": {"CpuShares": 256}}}}

def alloc(status, allocated=None, legacy=None):
    a = {"ID": "a", "ClientStatus": status, "Resources": {"Memory": {"MemoryMB": None}}}
    if allocated is not None:
        a["AllocatedResources"] = task(allocated)
    if legacy is not None:
        a["Resources"] = {"Memory": {"MemoryMB": legacy}, "Cpu": {"CpuShares": 256}}
    return a

# Allocated memory: 6 agents x 256 + Browserless 2048 + legacy-shape 128 + pending 100 = 3812.
# The failed allocation (999) must be ignored. Free = 3819 - 3812 = 7; a pending allocation
# occupies its node, so it is counted. CPU: 6x256 + 256 + 256 + 256 = 2304; free = 4000 - 2304 = 1696.
GOOD_ALLOCS = [alloc("running", 256) for _ in range(6)] + [
    alloc("running", 2048), alloc("running", legacy=128), alloc("pending", 100), alloc("failed", 999),
]
# One running allocation with no memory or CPU figure at all.
BAD_ALLOCS = GOOD_ALLOCS + [{"ID": "x", "ClientStatus": "running", "Resources": {"Memory": {"MemoryMB": None}}}]

FIXTURES = {"ok": GOOD_ALLOCS, "missing": BAD_ALLOCS, "nocpu": GOOD_ALLOCS}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        mode = self.server.mode
        if self.path == "/v1/status/leader":
            return self._send("10.0.0.2:4647")
        if self.path == "/v1/nodes":
            if mode == "error":
                # Error object returned with HTTP 200: nomad_api accepts it, so only the array check catches it.
                return self._send({"error": "Permission denied"})
            if mode == "nonarray":
                # An empty object iterates to no nodes, so without the array check it reproduces the exit-2 path.
                return self._send({})
            if mode == "noagent":
                # A genuine empty cluster: the only input that may reach exit 2.
                return self._send([])
            if mode == "detaildown":
                # The list stub still says ready/eligible for node-1; only its full object says down.
                return self._send([{"ID": NODE["ID"], "Status": "ready", "SchedulingEligibility": "eligible", "NodeClass": "agent"},
                                   {"ID": HEALTHY_NODE_B["ID"], "Status": "ready", "SchedulingEligibility": "eligible", "NodeClass": "agent"}])
            return self._send([{"ID": NODE["ID"], "Status": "ready", "SchedulingEligibility": "eligible", "NodeClass": "agent"},
                               OTHER_NODE_STUB,
                               {"ID": OTHER_POOL_NODE["ID"], "Status": "ready", "SchedulingEligibility": "eligible", "NodeClass": "agent"}])
        if self.path == f"/v1/node/{NODE['ID']}":
            if mode == "fetchfail":
                self.send_response(500)
                self.end_headers()
                return
            if mode == "nodeerr":
                # Error body with HTTP 200 on the node fetch: nomad_api accepts it, so only the node-object check catches it.
                return self._send({"error": "Permission denied"})
            if mode == "detaildown":
                return self._send(dict(NODE, Status="down", SchedulingEligibility="ineligible"))
            node = json.loads(json.dumps(NODE))
            if mode == "nocpu":
                del node["NodeResources"]["Cpu"]
            if mode == "nometa":
                del node["Meta"]
            if mode == "floatmem":
                node["NodeResources"]["Memory"]["MemoryMB"] = 3819.5
            return self._send(node)
        if self.path == f"/v1/node/{NODE['ID']}/allocations":
            return self._send(FIXTURES.get(mode, GOOD_ALLOCS))
        if self.path == f"/v1/node/{OTHER_POOL_NODE['ID']}":
            return self._send(OTHER_POOL_NODE)
        if self.path == f"/v1/node/{OTHER_POOL_NODE['ID']}/allocations":
            return self._send([alloc("running", 256)])
        if self.path == f"/v1/node/{HEALTHY_NODE_B['ID']}":
            return self._send(HEALTHY_NODE_B)
        if self.path == f"/v1/node/{HEALTHY_NODE_B['ID']}/allocations":
            return self._send([alloc("running", 256)])
        self.send_response(404)
        self.end_headers()

class Server(http.server.HTTPServer):
    mode = "ok"

server = Server(("127.0.0.1", int(sys.argv[1])), Handler)
server.mode = sys.argv[2] if len(sys.argv) > 2 else "ok"
server.serve_forever()
PY
}

start_server() {
  local mode="$1"
  if [[ -n "${SERVER_PID:-}" ]]; then kill "${SERVER_PID}" 2>/dev/null || true; wait "${SERVER_PID}" 2>/dev/null || true; fi
  python3 "${FAKE_SERVER}" "${PORT}" "${mode}" &
  SERVER_PID=$!
  for _ in $(seq 1 50); do
    if curl -s "http://127.0.0.1:${PORT}/v1/status/leader" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  echo "fake Nomad did not start" >&2
  exit 1
}

stop_server() {
  if [[ -n "${SERVER_PID:-}" ]]; then kill "${SERVER_PID}" 2>/dev/null || true; wait "${SERVER_PID}" 2>/dev/null || true; SERVER_PID=""; fi
}
trap 'stop_server; rm -f "${NOMAD_AUTOSCALE_LOG_FILE}" "${FAKE_SERVER}"' EXIT

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "PASS  ${name}"
  else
    echo "FAIL  ${name}: expected [${expected}] got [${actual}]"
    FAILURES=$((FAILURES + 1))
  fi
}

write_fake_server

# Case 1: current Nomad shape. Allocated memory must be read from AllocatedResources, pending
# counted, the NodeClass-other node excluded from the list, and the other-pool agent node
# excluded after its full object is fetched. Counting node-3 would give ready_nodes=2 and 3826 MB.
start_server ok
OUT="$(NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=256 bash "$SCRIPT" 2>/dev/null)"
check "free memory counts AllocatedResources, legacy and pending" "7" "$(echo "$OUT" | sed -n 's/^free_memory_mb=//p')"
check "no free slot with 7 MB free and 256 MB per agent" "0" "$(echo "$OUT" | sed -n 's/^free_slots=//p')"
check "only the herobids-pool agent node is counted" "1" "$(echo "$OUT" | sed -n 's/^ready_nodes=//p')"
stop_server

# Case 2: a running allocation with no memory figure must fail, not report the node as empty.
start_server missing
set +e
NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=256 bash "$SCRIPT" >/dev/null 2>&1
RC=$?
set -e
check "missing memory figure fails the check" "1" "$RC"
stop_server

# Case 3: a node without a CPU figure must fail, never be treated as zero CPU.
start_server nocpu
set +e
NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=256 bash "$SCRIPT" >/dev/null 2>&1
RC=$?
set -e
check "missing node CPU figure fails the check" "1" "$RC"
stop_server

# Case 4: CPU shortage with spare memory. Memory allows one slot (7 / 4), CPU does not (1696 / 2048).
start_server ok
OUT="$(NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=4 NOMAD_AGENT_CPU_RESERVATION_MHZ=2048 bash "$SCRIPT" 2>/dev/null)"
check "CPU shortage yields zero slots despite memory headroom" "0" "$(echo "$OUT" | sed -n 's/^free_slots=//p')"

# Case 5: both figures allow one slot. 7 / 4 = 1 and 1696 / 256 = 6, so the node gives one slot.
OUT="$(NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=4 NOMAD_AGENT_CPU_RESERVATION_MHZ=256 bash "$SCRIPT" 2>/dev/null)"
check "per-node slot is the minimum of memory and CPU" "1" "$(echo "$OUT" | sed -n 's/^free_slots=//p')"
stop_server

# Case 6: an error object in the node list must fail, not read as an empty cluster (exit 2 with
# READY_COUNT=0). nomad_api accepts the HTTP 200, so only the array check can catch it.
start_server error
set +e
OUT="$(NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=256 bash "$SCRIPT" 2>/dev/null)"
RC=$?
set -e
check "error object in node list fails the check" "1" "$RC"
check "error object in node list emits no capacity output" "" "$OUT"
stop_server

# Case 7: a non-array node list (object wrapping the nodes) must fail the same way.
start_server nonarray
set +e
OUT="$(NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=256 bash "$SCRIPT" 2>/dev/null)"
RC=$?
set -e
check "non-array node list fails the check" "1" "$RC"
check "non-array node list emits no capacity output" "" "$OUT"
stop_server

# Case 8: a failed fetch of a candidate's node object is fatal, not a silently skipped node.
start_server fetchfail
set +e
OUT="$(NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=256 bash "$SCRIPT" 2>/dev/null)"
RC=$?
set -e
check "failed node object fetch fails the check" "1" "$RC"
check "failed node object fetch emits no capacity output" "" "$OUT"
stop_server

# Case 9: a 200 error body in place of a node object must fail (jq error), not be skipped as
# "not this pool" and read as zero ready nodes (exit 2).
start_server nodeerr
set +e
OUT="$(NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=256 bash "$SCRIPT" 2>/dev/null)"
RC=$?
set -e
check "error body in place of node object fails the check" "1" "$RC"
check "error body in place of node object emits no capacity output" "" "$OUT"
stop_server

# Case 10: a node object without Meta is malformed, not a non-matching pool.
start_server nometa
set +e
OUT="$(NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=256 bash "$SCRIPT" 2>/dev/null)"
RC=$?
set -e
check "node object without Meta fails the check" "1" "$RC"
check "node object without Meta emits no capacity output" "" "$OUT"
stop_server

# Case 11: a non-integer memory figure must fail with exit 1, not reach require_uint's exit 2.
start_server floatmem
set +e
OUT="$(NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=256 bash "$SCRIPT" 2>/dev/null)"
RC=$?
set -e
check "float node memory fails the check with exit 1" "1" "$RC"
check "float node memory emits no capacity output" "" "$OUT"
stop_server

# Case 12: a non-numeric reservation is operator config. It must exit 1, never 2.
start_server ok
set +e
OUT="$(NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=abc bash "$SCRIPT" 2>/dev/null)"
RC=$?
set -e
check "non-numeric memory reservation fails the check with exit 1" "1" "$RC"
check "non-numeric memory reservation emits no capacity output" "" "$OUT"
stop_server

# Case 13: positive control. A genuine empty agent list is the only input that exits 2.
start_server noagent
set +e
OUT="$(NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=256 bash "$SCRIPT" 2>/dev/null)"
RC=$?
set -e
check "genuine zero ready agent nodes exits 2" "2" "$RC"
stop_server

# Case 14: a node the list shows as ready/eligible but whose full object is down/ineligible is
# skipped, not counted, and does not exit 2 by itself. node-4 is the only counted node: free memory
# 3819 - 256 = 3563. Counting node-1 as well would give ready_nodes=2 and 3570 MB.
start_server detaildown
set +e
OUT="$(NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=256 bash "$SCRIPT" 2>/dev/null)"
RC=$?
set -e
check "down node with ready list stub does not fail the run" "0" "$RC"
check "down node is not counted as ready" "1" "$(echo "$OUT" | sed -n 's/^ready_nodes=//p')"
check "down node contributes no free memory" "3563" "$(echo "$OUT" | sed -n 's/^free_memory_mb=//p')"
stop_server

if [[ "$FAILURES" -gt 0 ]]; then
  echo "${FAILURES} check(s) failed"
  exit 1
fi
echo "All checks passed"

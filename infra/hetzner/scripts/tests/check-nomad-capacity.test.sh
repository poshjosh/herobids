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
PORT="${TEST_NOMAD_PORT:-47646}"
FAILURES=0
export NOMAD_AUTOSCALE_LOG_FILE="$(mktemp)"
FAKE_SERVER="$(mktemp)"

write_fake_server() {
  cat > "$FAKE_SERVER" <<'PY'
import http.server, json, sys

NODE = {
    "ID": "node-1", "Status": "ready", "SchedulingEligibility": "eligible",
    "NodeResources": {"Memory": {"MemoryMB": 3819}},
    "ReservedResources": {"Memory": {"MemoryMB": 0}},
}

def task(mem):
    return {"Tasks": {"agent": {"Memory": {"MemoryMB": mem}}}}

def alloc(status, allocated=None, legacy=None):
    a = {"ID": "a", "ClientStatus": status, "Resources": {"Memory": {"MemoryMB": None}}}
    if allocated is not None:
        a["AllocatedResources"] = task(allocated)
    if legacy is not None:
        a["Resources"] = {"Memory": {"MemoryMB": legacy}}
    return a

# Allocated memory: 6 agents x 256 + Browserless 2048 + 1 legacy-shape alloc 128 = 3712.
# The failed allocation (999) must be ignored. Free = 3819 - 3712 = 107.
GOOD_ALLOCS = [alloc("running", 256) for _ in range(6)] + [
    alloc("running", 2048), alloc("running", legacy=128), alloc("failed", 999),
]
# One running allocation with no memory figure at all.
BAD_ALLOCS = GOOD_ALLOCS + [{"ID": "x", "ClientStatus": "running", "Resources": {"Memory": {"MemoryMB": None}}}]

FIXTURES = {"ok": GOOD_ALLOCS, "missing": BAD_ALLOCS}

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
            return self._send([{"ID": NODE["ID"], "Status": "ready", "SchedulingEligibility": "eligible"}])
        if self.path == f"/v1/node/{NODE['ID']}":
            return self._send(NODE)
        if self.path == f"/v1/node/{NODE['ID']}/allocations":
            return self._send(FIXTURES[mode])
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

# Case 1: current Nomad shape. Allocated memory must be read from AllocatedResources.
start_server ok
OUT="$(NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=256 bash "$SCRIPT" 2>/dev/null)"
check "free memory counts AllocatedResources and the legacy field" "107" "$(echo "$OUT" | sed -n 's/^free_memory_mb=//p')"
check "no free slot with 107 MB free and 256 MB per agent" "0" "$(echo "$OUT" | sed -n 's/^free_slots=//p')"
stop_server

# Case 2: a running allocation with no memory figure must fail, not report the node as empty.
start_server missing
set +e
NOMAD_ADDR="http://127.0.0.1:${PORT}" NOMAD_AGENT_MEMORY_RESERVATION_MB=256 bash "$SCRIPT" >/dev/null 2>&1
RC=$?
set -e
check "missing memory figure fails the check" "1" "$RC"
stop_server

if [[ "$FAILURES" -gt 0 ]]; then
  echo "${FAILURES} check(s) failed"
  exit 1
fi
echo "All checks passed"
